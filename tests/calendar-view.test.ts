import request from 'supertest';
import app, { ready } from '../src/backend/server';

describe('Calendar Viewer', () => {
  let calId: string;

  beforeAll(async () => {
    await ready;
    // Use the default calendar created on server startup
    const res = await request(app).get('/api/docs');
    calId = res.body.find((d: any) => d.type === 'Calendar')?.documentId ?? res.body[0].documentId;
  });

  afterAll(async () => {
    if (calId) {
      await request(app).post(`/api/docs/${calId}/reset`);
    }
  });

  describe('PATCH /docs/:documentId', () => {
    it('should return 404 for non-existent document', async () => {
      const response = await request(app)
        .patch('/docs/nonexistent')
        .send({ events: {} });
      expect(response.status).toBe(404);
    });

    it('should accept an empty patch', async () => {
      const response = await request(app)
        .patch(`/docs/${calId}`)
        .send({});
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('documentId', calId);
    });

    it('should add an event via patch', async () => {
      const uid = 'test-event-' + Date.now();
      const response = await request(app)
        .patch(`/docs/${calId}`)
        .send({
          events: {
            [uid]: {
              '@type': 'Event',
              title: 'Test Event',
              start: '2025-06-15T10:00:00',
              duration: 'PT1H',
              timeZone: null,
            }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.events[uid]).toBeDefined();
      expect(response.body.events[uid].title).toBe('Test Event');
      expect(response.body.events[uid].start).toBe('2025-06-15T10:00:00');
    });

    it('should update an existing event via patch', async () => {
      const uid = 'test-update-' + Date.now();

      // Create event
      await request(app)
        .patch(`/docs/${calId}`)
        .send({
          events: {
            [uid]: {
              '@type': 'Event',
              title: 'Original Title',
              start: '2025-06-15T10:00:00',
              duration: 'PT1H',
              timeZone: null,
            }
          }
        });

      // Update event
      const response = await request(app)
        .patch(`/docs/${calId}`)
        .send({
          events: {
            [uid]: { title: 'Updated Title' }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.events[uid].title).toBe('Updated Title');
      expect(response.body.events[uid].start).toBe('2025-06-15T10:00:00');
    });

    it('should add a recurrence override via patch', async () => {
      const uid = 'test-recurrence-' + Date.now();

      // Create recurring event
      await request(app)
        .patch(`/docs/${calId}`)
        .send({
          events: {
            [uid]: {
              '@type': 'Event',
              title: 'Weekly Meeting',
              start: '2025-06-15T10:00:00',
              duration: 'PT1H',
              timeZone: null,
              recurrenceRule: {
                '@type': 'RecurrenceRule',
                frequency: 'weekly',
              },
            }
          }
        });

      // Add override for one occurrence
      const response = await request(app)
        .patch(`/docs/${calId}`)
        .send({
          events: {
            [uid]: {
              recurrenceOverrides: {
                '2025-06-22T10:00:00': { title: 'Special Meeting' }
              }
            }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.events[uid].recurrenceOverrides['2025-06-22T10:00:00'].title)
        .toBe('Special Meeting');
      expect(response.body.events[uid].title).toBe('Weekly Meeting');
    });

    it('should support excluding a recurrence instance', async () => {
      const uid = 'test-exclude-' + Date.now();

      // Create recurring event
      await request(app)
        .patch(`/docs/${calId}`)
        .send({
          events: {
            [uid]: {
              '@type': 'Event',
              title: 'Daily Standup',
              start: '2025-06-15T09:00:00',
              duration: 'PT15M',
              timeZone: null,
              recurrenceRule: {
                '@type': 'RecurrenceRule',
                frequency: 'daily',
              },
            }
          }
        });

      // Exclude one occurrence
      const response = await request(app)
        .patch(`/docs/${calId}`)
        .send({
          events: {
            [uid]: {
              recurrenceOverrides: {
                '2025-06-17T09:00:00': { excluded: true }
              }
            }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.events[uid].recurrenceOverrides['2025-06-17T09:00:00'].excluded)
        .toBe(true);
    });
  });
});
