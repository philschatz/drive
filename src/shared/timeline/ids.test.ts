import { slug, idDate, readableId, newEntryId, randomSuffix, READABLE_ID_RE } from './ids';

describe('readable ids', () => {
  it('slugs names to lowercase ASCII words', () => {
    expect(slug('Snæfellsbær, Iceland')).toBe('snaefellsbaer-iceland');
    expect(slug('Praha – Modřany!', 1)).toBe('praha');
    expect(slug('São Paulo')).toBe('sao-paulo');
    expect(slug(undefined)).toBe('');
  });

  it('dates by the best guess, else the earliest, else the latest', () => {
    expect(idDate({ earliest: '2014-06-12', latest: '2014-06-12' })).toBe('2014-06-12');
    expect(idDate({ earliest: '2010', latest: '2012', best: '2011-05' })).toBe('2011-05');
    expect(idDate({ latest: '1999' })).toBe('1999');
    expect(idDate(undefined)).toBe('undated');
  });

  it('is date, place, first names, suffix — or the title when there is neither place nor people', () => {
    expect(readableId({ when: { earliest: '2014-06-12' }, location: 'Galveston, Texas, USA', people: ['Ana Ruiz', 'Ben', 'ana'] }, 'x7k2'))
      .toBe('2014-06-12-galveston-ana-ben-x7k2');
    expect(readableId({ when: { earliest: '2014-06-12' }, people: ['Ana', 'Ben', 'Carl', 'Dee'] }, 'x7k2')).toBe('2014-06-12-ana-ben-carl-x7k2');
    expect(readableId({ title: 'A dog called Max, our first' }, '8kd1')).toBe('undated-a-dog-called-max-8kd1');
    expect(readableId({ when: { earliest: '2010' } }, 'q3fd')).toBe('2010-q3fd');
    const long = readableId({ when: { earliest: '2014-06-12' }, location: 'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch', people: ['Bartholomew', 'Maximiliana'] }, 'x7k2');
    expect(long.length).toBeLessThanOrEqual(65);
    for (const id of ['2014-06-12-galveston-ana-ben-x7k2', 'undated-a-dog-8kd1', long]) expect(id).toMatch(READABLE_ID_RE);
    expect('k3j4l5m6n7').not.toMatch(READABLE_ID_RE);
  });

  it('a new entry gets a readable id no other entry has', () => {
    let i = 0;
    const rolls = [0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const random = () => rolls[i++ % rolls.length];
    const entry = { title: 'Beach weekend', when: { earliest: '2014-06-12' }, location: 'Galveston', participants: { s1: { name: 'Ana' } } };
    const first = readableId({ when: entry.when, location: 'Galveston', people: ['Ana'] }, randomSuffix(() => 0.1));
    expect(first).toBe('2014-06-12-galveston-ana-3333');
    i = 0;
    const id = newEntryId(entry, x => x === '2014-06-12-galveston-ana-3and', random);
    expect(id).toMatch(/^2014-06-12-galveston-ana-[a-z0-9]{4}$/);
    i = 0;
    const taken = new Set([newEntryId(entry, () => false, random)]);
    i = 0;
    expect(taken.has(newEntryId(entry, x => taken.has(x), random))).toBe(false);
  });
});
