import request from 'supertest';
import app, { ready } from '../src/backend/server';

let calId: string;

beforeAll(async () => {
  await ready;

  // Create a calendar via MKCALENDAR
  const res = await request(app)
    .mkcalendar('/dav/cal/test-cal/')
    .set('Content-Type', 'application/xml');
  calId = res.headers.location?.replace('/dav/cal/', '').replace('/', '') ?? '';
  expect(calId).toBeTruthy();
});

const SIMPLE_ICS = (uid: string) => `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:${uid}
DTSTART:20250615T100000
DTEND:20250615T110000
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`;

const RECURRING_ICS = (uid: string) => `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:${uid}
DTSTART:20250615T100000
DTEND:20250615T110000
SUMMARY:Weekly Meeting
RRULE:FREQ=WEEKLY
END:VEVENT
END:VCALENDAR`;

describe('CalDAV well-known discovery', () => {
  it('should redirect /.well-known/caldav to /dav/cal/', async () => {
    const res = await request(app).get('/.well-known/caldav');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dav/cal/');
  });
});

describe('CalDAV root collection', () => {
  it('HEAD /dav/cal/ should return DAV headers', async () => {
    const res = await request(app).head('/dav/cal/');
    expect(res.status).toBe(200);
    expect(res.headers.dav).toContain('calendar-access');
  });

  it('OPTIONS /dav/cal/ should succeed', async () => {
    const res = await (request(app) as any).options('/dav/cal/');
    expect([200, 204]).toContain(res.status);
  });

  it('PROPFIND /dav/cal/ depth 0 should return root collection', async () => {
    const res = await (request(app) as any)
      .propfind('/dav/cal/')
      .set('Depth', '0');
    expect(res.status).toBe(207);
    expect(res.text).toContain('<D:displayname>Calendars</D:displayname>');
    expect(res.text).toContain('calendar-home-set');
  });

  it('PROPFIND /dav/cal/ depth 1 should list calendars', async () => {
    const res = await (request(app) as any)
      .propfind('/dav/cal/')
      .set('Depth', '1');
    expect(res.status).toBe(207);
    expect(res.text).toContain(`/dav/cal/${calId}/`);
  });
});

describe('CalDAV calendar operations', () => {
  it('MKCALENDAR should create a new calendar', async () => {
    const res = await (request(app) as any)
      .mkcalendar('/dav/cal/new-cal/')
      .set('Content-Type', 'application/xml');
    expect(res.status).toBe(201);
    expect(res.headers.location).toMatch(/^\/dav\/cal\/.+\/$/);
  });

  it('GET /dav/cal/:id/ should return calendar as ICS', async () => {
    const res = await request(app).get(`/dav/cal/${calId}/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.text).toContain('BEGIN:VCALENDAR');
  });

  it('GET /dav/cal/:id/ should return 404 for missing calendar', async () => {
    const res = await request(app).get('/dav/cal/nonexistent/');
    expect(res.status).toBe(404);
  });

  it('OPTIONS /dav/cal/:id/ should succeed', async () => {
    const res = await (request(app) as any).options(`/dav/cal/${calId}/`);
    expect([200, 204]).toContain(res.status);
  });

  it('PROPFIND depth 0 should return calendar properties', async () => {
    const res = await (request(app) as any)
      .propfind(`/dav/cal/${calId}/`)
      .set('Depth', '0');
    expect(res.status).toBe(207);
    expect(res.text).toContain('<C:calendar/>');
    expect(res.text).toContain('<D:collection/>');
    expect(res.text).toContain('supported-calendar-component-set');
    expect(res.text).toContain('getctag');
    expect(res.text).toContain('sync-token');
  });

  it('PROPFIND depth 0 should return 404 for missing calendar', async () => {
    const res = await (request(app) as any)
      .propfind('/dav/cal/nonexistent/')
      .set('Depth', '0');
    expect(res.status).toBe(404);
  });

  it('PUT /dav/cal/:id/ should update calendar metadata', async () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Renamed Calendar
X-WR-CALDESC:A new description
END:VCALENDAR`;
    const res = await request(app)
      .put(`/dav/cal/${calId}/`)
      .set('Content-Type', 'text/calendar')
      .send(ics);
    expect(res.status).toBe(204);

    // Verify via PROPFIND
    const propRes = await (request(app) as any)
      .propfind(`/dav/cal/${calId}/`)
      .set('Depth', '0');
    expect(propRes.text).toContain('Renamed Calendar');
  });

  it('REPORT should return all events with calendar-data', async () => {
    // Add an event first
    const uid = 'report-test-event';
    await request(app)
      .put(`/dav/cal/${calId}/${uid}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS(uid));

    const res = await (request(app) as any)
      .report(`/dav/cal/${calId}/`)
      .set('Content-Type', 'application/xml');
    expect(res.status).toBe(207);
    expect(res.text).toContain(`${uid}.ics`);
    expect(res.text).toContain('calendar-data');

    // Cleanup
    await request(app).delete(`/dav/cal/${calId}/${uid}.ics`);
  });

  it('DELETE /dav/cal/:id/ should delete calendar', async () => {
    // Create a calendar to delete
    const mkRes = await (request(app) as any)
      .mkcalendar('/dav/cal/to-delete/')
      .set('Content-Type', 'application/xml');
    const deleteId = mkRes.headers.location.replace('/dav/cal/', '').replace('/', '');

    const res = await request(app).delete(`/dav/cal/${deleteId}/`);
    expect(res.status).toBe(204);

    // Verify it's gone
    const getRes = await request(app).get(`/dav/cal/${deleteId}/`);
    expect(getRes.status).toBe(404);
  });
});

describe('CalDAV event operations', () => {
  it('PUT should create a new event', async () => {
    const uid = 'new-event-1';
    const res = await request(app)
      .put(`/dav/cal/${calId}/${uid}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS(uid));
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers.location).toBe(`/dav/cal/${calId}/${uid}.ics`);
    expect(res.text).toContain('BEGIN:VCALENDAR');

    // Cleanup
    await request(app).delete(`/dav/cal/${calId}/${uid}.ics`);
  });

  it('PUT should update an existing event', async () => {
    const uid = 'update-event-1';
    // Create
    await request(app)
      .put(`/dav/cal/${calId}/${uid}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS(uid));

    // Update
    const updated = SIMPLE_ICS(uid).replace('Test Event', 'Updated Event');
    const res = await request(app)
      .put(`/dav/cal/${calId}/${uid}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(updated);
    expect(res.status).toBe(204);

    // Verify
    const getRes = await request(app).get(`/dav/cal/${calId}/${uid}.ics`);
    expect(getRes.text).toContain('Updated Event');

    // Cleanup
    await request(app).delete(`/dav/cal/${calId}/${uid}.ics`);
  });

  it('PUT should return 404 for missing calendar', async () => {
    const res = await request(app)
      .put('/dav/cal/nonexistent/event.ics')
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS('event'));
    expect(res.status).toBe(404);
  });

  it('PUT should return 400 for invalid ICS', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .put(`/dav/cal/${calId}/bad.ics`)
      .set('Content-Type', 'text/calendar')
      .send('not valid ics data');
    expect(res.status).toBe(400);
    spy.mockRestore();
  });

  it('PUT should handle recurring events', async () => {
    const uid = 'recurring-1';
    const res = await request(app)
      .put(`/dav/cal/${calId}/${uid}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(RECURRING_ICS(uid));
    expect(res.status).toBe(201);

    const getRes = await request(app).get(`/dav/cal/${calId}/${uid}.ics`);
    expect(getRes.text).toContain('RRULE');

    // Cleanup
    await request(app).delete(`/dav/cal/${calId}/${uid}.ics`);
  });

  it('GET should retrieve an event as ICS', async () => {
    const uid = 'get-event-1';
    await request(app)
      .put(`/dav/cal/${calId}/${uid}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS(uid));

    const res = await request(app).get(`/dav/cal/${calId}/${uid}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers.etag).toBeTruthy();
    expect(res.text).toContain('BEGIN:VCALENDAR');
    expect(res.text).toContain('Test Event');

    // Cleanup
    await request(app).delete(`/dav/cal/${calId}/${uid}.ics`);
  });

  it('GET should return 404 for missing event', async () => {
    const res = await request(app).get(`/dav/cal/${calId}/nonexistent.ics`);
    expect(res.status).toBe(404);
  });

  it('DELETE should remove an event', async () => {
    const uid = 'delete-event-1';
    await request(app)
      .put(`/dav/cal/${calId}/${uid}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS(uid));

    const res = await request(app).delete(`/dav/cal/${calId}/${uid}.ics`);
    expect(res.status).toBe(204);

    const getRes = await request(app).get(`/dav/cal/${calId}/${uid}.ics`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE should return 404 for missing event', async () => {
    const res = await request(app).delete(`/dav/cal/${calId}/nonexistent.ics`);
    expect(res.status).toBe(404);
  });

  it('PROPFIND on event should return properties', async () => {
    const uid = 'propfind-event-1';
    await request(app)
      .put(`/dav/cal/${calId}/${uid}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS(uid));

    const res = await (request(app) as any)
      .propfind(`/dav/cal/${calId}/${uid}.ics`)
      .set('Depth', '0');
    expect(res.status).toBe(207);
    expect(res.text).toContain('getetag');
    expect(res.text).toContain(`${uid}.ics`);

    // Cleanup
    await request(app).delete(`/dav/cal/${calId}/${uid}.ics`);
  });

  it('PROPFIND should return 404 for missing event', async () => {
    const res = await (request(app) as any)
      .propfind(`/dav/cal/${calId}/nonexistent.ics`)
      .set('Depth', '0');
    expect(res.status).toBe(404);
  });

  it('OPTIONS on event should succeed', async () => {
    const res = await (request(app) as any)
      .options(`/dav/cal/${calId}/any-event.ics`);
    expect([200, 204]).toContain(res.status);
  });
});

describe('CalDAV PROPFIND depth 1 lists events', () => {
  const uid1 = 'depth1-event-a';
  const uid2 = 'depth1-event-b';

  beforeAll(async () => {
    await request(app)
      .put(`/dav/cal/${calId}/${uid1}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS(uid1));
    await request(app)
      .put(`/dav/cal/${calId}/${uid2}.ics`)
      .set('Content-Type', 'text/calendar')
      .send(SIMPLE_ICS(uid2));
  });

  afterAll(async () => {
    await request(app).delete(`/dav/cal/${calId}/${uid1}.ics`);
    await request(app).delete(`/dav/cal/${calId}/${uid2}.ics`);
  });

  it('should list all events in the calendar', async () => {
    const res = await (request(app) as any)
      .propfind(`/dav/cal/${calId}/`)
      .set('Depth', '1');
    expect(res.status).toBe(207);
    expect(res.text).toContain(`${uid1}.ics`);
    expect(res.text).toContain(`${uid2}.ics`);
    expect(res.text).toContain('getetag');
  });
});
