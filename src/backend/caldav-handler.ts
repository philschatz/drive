import { Request, Response } from 'express';
import { Repo, DocumentId } from '@automerge/automerge-repo';
import { icsToEvent } from './parser';
import { eventToICS, calendarToIcs, generateEtag } from './serializer';
import { getHandle, listByType, getHeadsHash } from './doc-store';
import { deepAssign } from '../shared/deep-assign';

/**
 * CalDAV Protocol Handler
 * Implements CalDAV methods for calendar access
 * Methods are organized by resource type (event, calendar, root collection)
 */
export class CalDAVHandler {
  constructor(private repo: Repo) {}

  // ===== Event-level operations =====

  /**
   * GET - Retrieve a specific event
   */
  handleEventGet(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const uid = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;

    const handle = getHandle(this.repo, calendarId, 'Calendar');
    const event = handle?.doc()?.events?.[uid];

    if (!event) {
      res.status(404).send('Event not found');
      return;
    }

    const icsContent = eventToICS(uid, event);

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('ETag', `"${generateEtag(event)}"`);
    res.send(icsContent);
  }

  /**
   * PUT - Create or update an event
   */
  handleEventPut(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const uid = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;

    const handle = getHandle(this.repo, calendarId, 'Calendar');
    if (!handle) {
      res.status(404).send('Calendar not found');
      return;
    }

    try {
      const icsContent = req.body;
      const events = icsToEvent(icsContent);

      if (events.length === 0) {
        res.status(400).send('No valid events in ICS data');
        return;
      }

      let isNewEvent = false;

      for (const {uid: eventId, event} of events) {
        if (eventId !== uid) throw new Error(`BUG: Expected event id to be '${uid}' because of route but instead it was '${eventId}'`);

        const existingEvent = handle.doc()?.events?.[uid];

        if (existingEvent) {
          if (event.timeZone === null && event.start && event.start.length > 10 && existingEvent.timeZone) {
            event.timeZone = existingEvent.timeZone;
          }
          if (!event.recurrenceRule && existingEvent.recurrenceRule) {
            (event as any).recurrenceRule = undefined;
          }
          handle.change((d: any) => { deepAssign(d.events[uid], event); });
        } else {
          handle.change((d: any) => { d.events[uid] = event; });
          isNewEvent = true;
        }
      }

      const finalEvent = handle.doc()?.events?.[uid];
      const eventIcs = eventToICS(uid, finalEvent);
      if (isNewEvent) {
        res.status(201);
      } else {
        res.status(204);
      }
      res.set('Location', `/dav/cal/${calendarId}/${uid}.ics`);
      res.set('ETag', `"${generateEtag(finalEvent)}"`);
      res.send(eventIcs);

    } catch (error) {
      console.error('PUT error:', error);
      res.status(400).send('Invalid ICS data');
    }
  }

  /**
   * DELETE - Delete a specific event
   */
  handleEventDelete(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const uid = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;

    const handle = getHandle(this.repo, calendarId, 'Calendar');
    if (!handle?.doc()?.events?.[uid]) {
      res.status(404).send('Event not found');
      return;
    }

    handle.change((d: any) => { delete d.events[uid]; });
    res.status(204).send();
  }

  /**
   * PROPFIND - Retrieve properties of a specific event
   */
  handleEventPropfind(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const uid = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;

    const handle = getHandle(this.repo, calendarId, 'Calendar');
    const event = handle?.doc()?.events?.[uid];

    if (!event) {
      res.status(404).send('Event not found');
      return;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/cal/${calendarId}/${uid}.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getetag>"${generateEtag(event)}"</D:getetag>
        <D:getcontenttype>text/calendar; component=VEVENT</D:getcontenttype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

    res.status(207);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  }

  /**
   * OPTIONS - Return allowed methods for events
   */
  handleEventOptions(_req: Request, res: Response): void {
    res.set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND');
    res.set('DAV', '1, 2, 3, calendar-access');
    res.status(200).send();
  }

  // ===== Calendar-level operations =====

  /**
   * GET - Retrieve all events from a calendar
   */
  handleCalendarGet(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const handle = getHandle(this.repo, calendarId, 'Calendar');

    if (!handle) {
      res.status(404).send('Calendar not found');
      return;
    }

    const doc = handle.doc();
    const events = Object.entries(doc.events || {}).map(([uid, event]: [string, any]) => ({ uid, event }));
    const icsContent = calendarToIcs(events, doc.name);

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.send(icsContent);
  }

  /**
   * PUT - Update calendar metadata and events
   */
  handleCalendarPut(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const handle = getHandle(this.repo, calendarId, 'Calendar');

    if (!handle) {
      res.status(404).send('Calendar not found');
      return;
    }

    try {
      const icsContent = req.body;
      const updates: any = {};

      const nameMatch = icsContent.match(/X-WR-CALNAME:(.+)/i);
      if (nameMatch) updates.name = nameMatch[1].trim();

      const descMatch = icsContent.match(/X-WR-CALDESC:(.+)/i);
      if (descMatch) updates.description = descMatch[1].trim();

      const colorMatch = icsContent.match(/X-APPLE-CALENDAR-COLOR:(.+)/i);
      if (colorMatch) updates.color = colorMatch[1].trim();

      if (Object.keys(updates).length > 0) {
        handle.change((d: any) => { deepAssign(d, updates); });
      }

      const events = icsToEvent(icsContent);

      for (const { uid, event } of events) {
        const existingEvent = handle.doc()?.events?.[uid];

        if (existingEvent) {
          if (event.timeZone === null && event.start && event.start.length > 10 && existingEvent.timeZone) {
            event.timeZone = existingEvent.timeZone;
          }
          if (!event.recurrenceRule && existingEvent.recurrenceRule) {
            (event as any).recurrenceRule = undefined;
          }
          handle.change((d: any) => { deepAssign(d.events[uid], event); });
        } else {
          handle.change((d: any) => { d.events[uid] = event; });
        }
      }

      res.status(204).send();
    } catch (error) {
      console.error('PUT calendar error:', error);
      res.status(400).send('Invalid ICS data');
    }
  }

  /**
   * DELETE - Delete a calendar
   */
  handleCalendarDelete(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const handle = getHandle(this.repo, calendarId, 'Calendar');

    if (!handle) {
      res.status(404).send('Calendar not found');
      return;
    }

    this.repo.delete(calendarId as DocumentId);
    res.status(204).send();
  }

  /**
   * PROPFIND - Retrieve properties of a calendar
   */
  handleCalendarPropfind(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const depth = req.headers.depth || '0';
    const handle = getHandle(this.repo, calendarId, 'Calendar');

    if (!handle) {
      res.status(404).send('Calendar not found');
      return;
    }

    const doc = handle.doc();
    let eventItems = '';
    if (depth !== '0') {
      const events = Object.entries(doc.events || {});
      eventItems = events.map(([uid, event]: [string, any]) => `
      <D:response>
        <D:href>/dav/cal/${calendarId}/${uid}.ics</D:href>
        <D:propstat>
          <D:prop>
            <D:resourcetype/>
            <D:getetag>"${generateEtag(event)}"</D:getetag>
            <D:getcontenttype>text/calendar; component=VEVENT</D:getcontenttype>
          </D:prop>
          <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
      </D:response>`).join('\n');
    }

    const syncToken = getHeadsHash(this.repo, calendarId) || '0';

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/dav/cal/${calendarId}/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype>
          <D:collection/>
          <C:calendar/>
        </D:resourcetype>
        <D:displayname>${this.escapeXml(doc.name)}</D:displayname>
        <C:calendar-description>${this.escapeXml(doc.description || '')}</C:calendar-description>
        <C:supported-calendar-component-set>
          <C:comp name="VEVENT"/>
        </C:supported-calendar-component-set>
        <C:supported-calendar-data>
          <C:calendar-data content-type="text/calendar" version="2.0"/>
        </C:supported-calendar-data>
        <CS:getctag>${syncToken}</CS:getctag>
        <D:sync-token>data:,${syncToken}</D:sync-token>
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
          <D:privilege><D:write/></D:privilege>
          <D:privilege><D:write-properties/></D:privilege>
          <D:privilege><D:write-content/></D:privilege>
          <D:privilege><D:bind/></D:privilege>
          <D:privilege><D:unbind/></D:privilege>
        </D:current-user-privilege-set>
        <D:owner>
          <D:href>/dav/cal/</D:href>
        </D:owner>${doc.color ? `
        <X:calendar-color xmlns:X="http://apple.com/ns/ical/">${this.escapeXml(doc.color)}</X:calendar-color>` : ''}${doc.timeZone ? `
        <C:calendar-timezone>${this.escapeXml(doc.timeZone)}</C:calendar-timezone>` : ''}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  ${eventItems}
</D:multistatus>`;

    res.status(207);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('DAV', '1, 2, 3, calendar-access');
    res.send(xml);
  }

  /**
   * REPORT - Query calendar data with filtering
   */
  handleCalendarReport(req: Request, res: Response): void {
    const calendarId = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;
    const handle = getHandle(this.repo, calendarId, 'Calendar');

    if (!handle) {
      res.status(404).send('Calendar not found');
      return;
    }

    const doc = handle.doc();
    const events = Object.entries(doc.events || {});

    const items = events.map(([uid, event]: [string, any]) => {
      const ics = eventToICS(uid, event);
      return `
        <D:response>
          <D:href>/dav/cal/${calendarId}/${uid}.ics</D:href>
          <D:propstat>
            <D:prop>
              <D:getetag>"${generateEtag(event)}"</D:getetag>
              <C:calendar-data>${this.escapeXml(ics)}</C:calendar-data>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  ${items}
</D:multistatus>`;

    res.status(207);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  }

  /**
   * MKCALENDAR - Create a new calendar
   */
  handleCalendarMkcalendar(req: Request, res: Response): void {
    const requestedName = Array.isArray(req.params.calendarId) ? req.params.calendarId[0] : req.params.calendarId;

    const handle = this.repo.create();
    handle.change((d: any) => {
      d['@type'] = 'Calendar';
      d.name = requestedName;
      d.description = `Calendar ${requestedName}`;
      d.events = {};
    });

    res.status(201);
    res.set('Location', `/dav/cal/${handle.documentId}/`);
    res.send();
  }

  /**
   * OPTIONS - Return allowed methods for calendars
   */
  handleCalendarOptions(_req: Request, res: Response): void {
    res.set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT, MKCALENDAR');
    res.set('DAV', '1, 2, 3, calendar-access');
    res.status(200).send();
  }

  // ===== Root collection operations =====

  /**
   * PROPFIND - Retrieve properties of the root calendar collection
   */
  handleRootPropfind(req: Request, res: Response): void {
    const depth = req.headers.depth || '0';
    const calendars = listByType(this.repo, 'Calendar');

    let calendarItems = '';
    if (depth !== '0') {
      calendarItems = calendars.map(cal => `
      <D:response>
        <D:href>/dav/cal/${cal.documentId}/</D:href>
        <D:propstat>
          <D:prop>
            <D:resourcetype>
              <D:collection/>
              <C:calendar/>
            </D:resourcetype>
            <D:displayname>${this.escapeXml(cal.doc.name)}</D:displayname>
            <C:calendar-description>${this.escapeXml(cal.doc.description || '')}</C:calendar-description>
            <C:supported-calendar-component-set>
              <C:comp name="VEVENT"/>
            </C:supported-calendar-component-set>
          </D:prop>
          <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
      </D:response>`).join('\n');
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/cal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype>
          <D:collection/>
        </D:resourcetype>
        <D:displayname>Calendars</D:displayname>
        <D:current-user-principal>
          <D:href>/dav/cal/</D:href>
        </D:current-user-principal>
        <C:calendar-home-set>
          <D:href>/dav/cal/</D:href>
        </C:calendar-home-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  ${calendarItems}
</D:multistatus>`;

    res.status(207);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('DAV', '1, 2, 3, calendar-access');
    res.send(xml);
  }

  /**
   * REPORT - Query root collection (not typically used)
   */
  handleRootReport(_req: Request, res: Response): void {
    res.status(501).send('REPORT on root collection not implemented');
  }

  /**
   * OPTIONS - Return allowed methods for root collection
   */
  handleRootOptions(_req: Request, res: Response): void {
    res.set('Allow', 'OPTIONS, PROPFIND');
    res.set('DAV', '1, 2, 3, calendar-access');
    res.status(200).send();
  }

  // ===== Private helper methods =====

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
