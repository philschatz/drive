import { Router, Request, Response } from 'express';
import { CalDAVHandler } from '../caldav-handler';

export function createDavRoutes(caldavHandler: CalDAVHandler): Router {
  const router = Router();

  (router as any).propfind('/', (req: Request, res: Response) => {
    caldavHandler.handleRootPropfind(req, res);
  });

  // Well-known CalDAV discovery endpoint (RFC 6764)
  router.all('/.well-known/caldav', (_req: Request, res: Response) => {
    res.redirect(302, '/dav/cal/');
  });

  // ===== CalDAV Endpoints =====

  // Event-level operations: /dav/cal/:calendarId/:eventId.ics
  router.get('/dav/cal/:calendarId/:eventId.ics', (req: Request, res: Response) => {
    caldavHandler.handleEventGet(req, res);
  });

  router.put('/dav/cal/:calendarId/:eventId.ics', (req: Request, res: Response) => {
    caldavHandler.handleEventPut(req, res);
  });

  router.delete('/dav/cal/:calendarId/:eventId.ics', (req: Request, res: Response) => {
    caldavHandler.handleEventDelete(req, res);
  });

  router.all('/dav/cal/:calendarId/:eventId.ics', (req: Request, res: Response) => {
    if (['PROPFIND', 'OPTIONS'].includes(req.method.toUpperCase())) {
      switch (req.method.toUpperCase()) {
        case 'PROPFIND':
          caldavHandler.handleEventPropfind(req, res);
          break;
        case 'OPTIONS':
          caldavHandler.handleEventOptions(req, res);
          break;
      }
    } else if (!['GET', 'PUT', 'DELETE'].includes(req.method.toUpperCase())) {
      res.status(405).send('Method Not Allowed');
    }
  });

  // Calendar-level operations: /dav/cal/:calendarId/
  router.get('/dav/cal/:calendarId/', (req: Request, res: Response) => {
    caldavHandler.handleCalendarGet(req, res);
  });

  router.put('/dav/cal/:calendarId/', (req: Request, res: Response) => {
    caldavHandler.handleCalendarPut(req, res);
  });

  router.delete('/dav/cal/:calendarId/', (req: Request, res: Response) => {
    caldavHandler.handleCalendarDelete(req, res);
  });

  router.all('/dav/cal/:calendarId/', (req: Request, res: Response) => {
    if (['PROPFIND', 'REPORT', 'MKCALENDAR', 'OPTIONS'].includes(req.method.toUpperCase())) {
      switch (req.method.toUpperCase()) {
        case 'PROPFIND':
          caldavHandler.handleCalendarPropfind(req, res);
          break;
        case 'REPORT':
          caldavHandler.handleCalendarReport(req, res);
          break;
        case 'MKCALENDAR':
          caldavHandler.handleCalendarMkcalendar(req, res);
          break;
        case 'OPTIONS':
          caldavHandler.handleCalendarOptions(req, res);
          break;
      }
    } else if (!['GET', 'PUT', 'DELETE'].includes(req.method.toUpperCase())) {
      res.status(405).send('Method Not Allowed');
    }
  });

  // Root collection operations: /dav/cal/
  router.head('/dav/cal/', (_req: Request, res: Response) => {
    res.set('DAV', '1, 2, 3, calendar-access');
    res.set('Allow', 'OPTIONS, HEAD, PROPFIND, REPORT');
    res.status(200).end();
  });

  router.all('/dav/cal/', (req: Request, res: Response) => {
    if (['PROPFIND', 'REPORT', 'OPTIONS'].includes(req.method.toUpperCase())) {
      switch (req.method.toUpperCase()) {
        case 'PROPFIND':
          caldavHandler.handleRootPropfind(req, res);
          break;
        case 'REPORT':
          caldavHandler.handleRootReport(req, res);
          break;
        case 'OPTIONS':
          caldavHandler.handleRootOptions(req, res);
          break;
      }
    } else {
      res.status(405).send('Method Not Allowed');
    }
  });

  return router;
}
