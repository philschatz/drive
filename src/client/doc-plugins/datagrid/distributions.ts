/**
 * Probabilistic distribution types, sampling algorithms, and statistics.
 */

export type DistributionType =
  | 'normal' | 'uniform' | 'triangular' | 'pert' | 'lognormal'
  | 'beta' | 'exponential' | 'gamma' | 'cauchy' | 'weibull'
  | 'bernoulli' | 'binomial' | 'poisson';

export interface DistributionInfo {
  type: DistributionType;
  params: number[];
}

export interface DistributionStats {
  mean: number;
  stdev: number;
  min: number;
  max: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  histogram: number[]; // 20 bins, normalized to max = 1
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Sample a single value from a distribution. */
export function sampleDistribution(info: DistributionInfo): number {
  switch (info.type) {
    case 'normal': return sampleNormal(info.params[0], info.params[1]);
    case 'uniform': return sampleUniform(info.params[0], info.params[1]);
    case 'triangular': return sampleTriangular(info.params[0], info.params[1], info.params[2]);
    case 'pert': return samplePert(info.params[0], info.params[1], info.params[2]);
    case 'lognormal': return sampleLognormal(info.params[0], info.params[1]);
    case 'beta': return sampleBeta(info.params[0], info.params[1]);
    case 'exponential': return sampleExponential(info.params[0]);
    case 'gamma': return sampleGamma(info.params[0]) * info.params[1];
    case 'cauchy': return sampleCauchy(info.params[0], info.params[1]);
    case 'weibull': return sampleWeibull(info.params[0], info.params[1]);
    case 'bernoulli': return Math.random() < info.params[0] ? 1 : 0;
    case 'binomial': return sampleBinomial(info.params[0], info.params[1]);
    case 'poisson': return samplePoisson(info.params[0]);
  }
}

/** Analytical mean of a distribution. */
export function distributionMean(info: DistributionInfo): number {
  switch (info.type) {
    case 'normal': return info.params[0];
    case 'uniform': return (info.params[0] + info.params[1]) / 2;
    case 'triangular': return (info.params[0] + info.params[1] + info.params[2]) / 3;
    case 'pert': {
      const [min, mode, max] = info.params;
      return (min + 4 * mode + max) / 6;
    }
    case 'lognormal': {
      const [mu, sigma] = info.params;
      return Math.exp(mu + sigma * sigma / 2);
    }
    case 'beta': return info.params[0] / (info.params[0] + info.params[1]);
    case 'exponential': return 1 / info.params[0];
    case 'gamma': return info.params[0] * info.params[1];
    case 'cauchy': return info.params[0]; // median (mean is undefined)
    case 'weibull': {
      const [lambda, k] = info.params;
      return lambda * gamma(1 + 1 / k);
    }
    case 'bernoulli': return info.params[0];
    case 'binomial': return info.params[0] * info.params[1];
    case 'poisson': return info.params[0];
  }
}

// Box-Muller transform
function sampleNormal(mean: number, stdev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + stdev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleUniform(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sampleTriangular(min: number, max: number, mode: number): number {
  const u = Math.random();
  const f = (mode - min) / (max - min);
  if (u < f) return min + Math.sqrt(u * (max - min) * (mode - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

// Beta-PERT using gamma sampling (Marsaglia & Tsang method)
function samplePert(min: number, mode: number, max: number): number {
  const range = max - min;
  if (range <= 0) return min;
  const mu = (min + 4 * mode + max) / 6;
  const alpha = ((mu - min) * (2 * mode - min - max)) / ((mode - mu) * (max - min)) || 2;
  const beta = (alpha * (max - mu)) / (mu - min) || 2;
  const a = Math.max(alpha, 0.5);
  const b = Math.max(beta, 0.5);
  const x = sampleBeta(a, b);
  return min + x * range;
}

function sampleLognormal(mu: number, sigma: number): number {
  return Math.exp(sampleNormal(mu, sigma));
}

// Marsaglia & Tsang's method for gamma distribution
function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = sampleNormal(0, 1);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

function sampleExponential(lambda: number): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return -Math.log(u) / lambda;
}

function sampleCauchy(x0: number, gamma: number): number {
  return x0 + gamma * Math.tan(Math.PI * (Math.random() - 0.5));
}

function sampleWeibull(lambda: number, k: number): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return lambda * Math.pow(-Math.log(u), 1 / k);
}

function sampleBinomial(n: number, p: number): number {
  let successes = 0;
  const trials = Math.round(n);
  for (let i = 0; i < trials; i++) {
    if (Math.random() < p) successes++;
  }
  return successes;
}

function samplePoisson(lambda: number): number {
  // Knuth's algorithm
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

// Lanczos approximation of the gamma function (for Weibull mean)
function gamma(z: number): number {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function computeStats(samples: number[]): DistributionStats {
  if (samples.length === 0) {
    return { mean: 0, stdev: 0, min: 0, max: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, histogram: Array(20).fill(0) };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);

  const percentile = (p: number) => {
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  // 20-bin histogram
  const min = sorted[0];
  const max = sorted[n - 1];
  const bins = Array(20).fill(0) as number[];
  if (max > min) {
    const binWidth = (max - min) / 20;
    for (const v of sorted) {
      const bi = Math.min(19, Math.floor((v - min) / binWidth));
      bins[bi]++;
    }
    const maxBin = Math.max(...bins);
    if (maxBin > 0) for (let i = 0; i < 20; i++) bins[i] /= maxBin;
  } else {
    bins[10] = 1; // all samples identical
  }

  return {
    mean, stdev, min, max,
    p5: percentile(5),
    p25: percentile(25),
    p50: percentile(50),
    p75: percentile(75),
    p95: percentile(95),
    histogram: bins,
  };
}

/** Format a number for display (compact). */
export function formatNum(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
  if (Math.abs(v) >= 1e6 || Math.abs(v) < 0.01) return v.toExponential(2);
  return v.toFixed(2);
}
