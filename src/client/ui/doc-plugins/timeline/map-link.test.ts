import { parseGeo, mapUrl, geoText } from './map-link';

describe('map links', () => {
  it('turns geo: coordinates into an OpenStreetMap marker link', () => {
    expect(parseGeo('geo:45.51592,-122.67585')).toEqual({ lat: 45.51592, lng: -122.67585 });
    expect(mapUrl('geo:45.51592,-122.67585')).toBe('https://www.openstreetmap.org/?mlat=45.51592&mlon=-122.67585#map=15/45.51592/-122.67585');
    expect(geoText('geo:-33.9,18')).toBe('-33.9, 18');
  });

  it('has nothing for missing, malformed or out-of-range coordinates', () => {
    for (const c of [undefined, '', 'geo:', '45.5,-122.6', 'geo:45.5', 'geo:95,10', 'geo:10,190', 'geo:1,2;u=35', 'javascript:alert(1)']) {
      expect(mapUrl(c)).toBeNull();
      expect(geoText(c)).toBe('');
    }
  });
});
