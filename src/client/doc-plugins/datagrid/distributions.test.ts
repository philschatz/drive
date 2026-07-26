import {
  sampleDistribution,
  distributionMean,
  computeStats,
  formatNum,
  type DistributionInfo,
} from './distributions';

describe('distributions', () => {
  describe('sampleDistribution', () => {
    it('normal: samples within reasonable range', () => {
      const info: DistributionInfo = { type: 'normal', params: [100, 10] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      expect(mean).toBeGreaterThan(90);
      expect(mean).toBeLessThan(110);
    });

    it('uniform: samples within [min, max]', () => {
      const info: DistributionInfo = { type: 'uniform', params: [5, 15] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(5);
      expect(Math.max(...samples)).toBeLessThanOrEqual(15);
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      expect(mean).toBeGreaterThan(8);
      expect(mean).toBeLessThan(12);
    });

    it('triangular: samples within [min, max]', () => {
      const info: DistributionInfo = { type: 'triangular', params: [0, 10, 5] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...samples)).toBeLessThanOrEqual(10);
    });

    it('pert: samples within [min, max]', () => {
      const info: DistributionInfo = { type: 'pert', params: [1, 5, 10] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...samples)).toBeLessThanOrEqual(10);
    });

    it('lognormal: samples are positive', () => {
      const info: DistributionInfo = { type: 'lognormal', params: [0, 0.5] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(samples.every(s => s > 0)).toBe(true);
    });

    it('beta: samples within [0, 1]', () => {
      const info: DistributionInfo = { type: 'beta', params: [2, 5] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(samples.every(s => s >= 0 && s <= 1)).toBe(true);
    });

    it('exponential: samples are positive', () => {
      const info: DistributionInfo = { type: 'exponential', params: [2] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(samples.every(s => s > 0)).toBe(true);
    });

    it('gamma: samples are positive', () => {
      const info: DistributionInfo = { type: 'gamma', params: [3, 2] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(samples.every(s => s > 0)).toBe(true);
    });

    it('weibull: samples are positive', () => {
      const info: DistributionInfo = { type: 'weibull', params: [1, 1.5] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(samples.every(s => s > 0)).toBe(true);
    });

    it('bernoulli: samples are 0 or 1', () => {
      const info: DistributionInfo = { type: 'bernoulli', params: [0.3] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(samples.every(s => s === 0 || s === 1)).toBe(true);
    });

    it('binomial: samples are non-negative integers', () => {
      const info: DistributionInfo = { type: 'binomial', params: [20, 0.5] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(samples.every(s => s >= 0 && s <= 20 && Number.isInteger(s))).toBe(true);
    });

    it('poisson: samples are non-negative integers', () => {
      const info: DistributionInfo = { type: 'poisson', params: [5] };
      const samples = Array.from({ length: 1000 }, () => sampleDistribution(info));
      expect(samples.every(s => s >= 0 && Number.isInteger(s))).toBe(true);
    });
  });

  describe('distributionMean', () => {
    it('normal mean', () => {
      expect(distributionMean({ type: 'normal', params: [50, 10] })).toBe(50);
    });

    it('uniform mean', () => {
      expect(distributionMean({ type: 'uniform', params: [0, 100] })).toBe(50);
    });

    it('triangular mean', () => {
      expect(distributionMean({ type: 'triangular', params: [0, 12, 6] })).toBe(6);
    });

    it('pert mean', () => {
      const mean = distributionMean({ type: 'pert', params: [1, 5, 10] });
      expect(mean).toBeCloseTo((1 + 4 * 5 + 10) / 6, 5);
    });

    it('lognormal mean', () => {
      const mean = distributionMean({ type: 'lognormal', params: [0, 1] });
      expect(mean).toBeCloseTo(Math.exp(0.5), 5);
    });

    it('beta mean', () => {
      expect(distributionMean({ type: 'beta', params: [2, 5] })).toBeCloseTo(2 / 7, 5);
    });

    it('exponential mean', () => {
      expect(distributionMean({ type: 'exponential', params: [4] })).toBeCloseTo(0.25, 5);
    });

    it('gamma mean', () => {
      expect(distributionMean({ type: 'gamma', params: [3, 2] })).toBe(6);
    });

    it('cauchy returns location as mean', () => {
      expect(distributionMean({ type: 'cauchy', params: [5, 2] })).toBe(5);
    });

    it('bernoulli mean', () => {
      expect(distributionMean({ type: 'bernoulli', params: [0.7] })).toBe(0.7);
    });

    it('binomial mean', () => {
      expect(distributionMean({ type: 'binomial', params: [20, 0.3] })).toBe(6);
    });

    it('poisson mean', () => {
      expect(distributionMean({ type: 'poisson', params: [4.5] })).toBe(4.5);
    });
  });

  describe('computeStats', () => {
    it('computes percentiles correctly', () => {
      const samples = Array.from({ length: 1000 }, (_, i) => i);
      const stats = computeStats(samples);
      expect(stats.p50).toBeCloseTo(499.5, 0);
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(999);
    });

    it('histogram has 20 bins', () => {
      const samples = Array.from({ length: 500 }, () => Math.random());
      const stats = computeStats(samples);
      expect(stats.histogram).toHaveLength(20);
      expect(Math.max(...stats.histogram)).toBe(1);
    });

    it('handles empty samples', () => {
      const stats = computeStats([]);
      expect(stats.mean).toBe(0);
      expect(stats.stdev).toBe(0);
    });
  });

  describe('formatNum', () => {
    it('formats integers', () => {
      expect(formatNum(42)).toBe('42');
    });

    it('formats decimals', () => {
      expect(formatNum(3.14159)).toBe('3.14');
    });

    it('formats large numbers in scientific notation', () => {
      expect(formatNum(1234567)).toMatch(/e\+/);
    });

    it('formats small numbers in scientific notation', () => {
      expect(formatNum(0.001)).toMatch(/e-/);
    });
  });
});
