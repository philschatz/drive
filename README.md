# Automerge Calendar

A TypeScript-based calendar application that parses iCalendar (.ics) files into JMAP (JSON Meta Application Protocol) format.

## Features

- **Full ICS to JMAP Conversion**: Comprehensive parser supporting all major iCalendar features
- **Multi-Calendar Store**: Global map of Automerge CRDT documents, each representing a separate calendar
- **CalDAV Protocol Support**: Standard CalDAV server implementation for calendar client compatibility
- **CRDT-Based Sync**: Built on Automerge for conflict-free collaborative editing
- **Type-Safe**: Built with TypeScript for robust type checking
- **Well-Tested**: Comprehensive test suite with Jest (69 tests)
- **Standards Compliant**: Based on JSCalendar (RFC 8984), JMAP for Calendars, and CalDAV (RFC 4791)

## Installation

```bash
npm install
```

## Usage

### Web Server (API)

Start the web server:

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm run build
npm start
```

The server will start on `http://localhost:3000` (or the port specified in `PORT` environment variable).

## Example commands

```bash
# curl -X MKCALENDAR http://localhost:3000/caldav/another-calendar/

plann --caldav-url http://localhost:3000/caldav/ list-calendars

plann --caldav-url http://localhost:3000/caldav/ select list                   # Should have one entry

plann --caldav-url http://localhost:3000/caldav/ add event "intitial event" 2004-11-25+5d
plann --caldav-url http://localhost:3000/caldav/ add event "release party" 2004-11-30T19:00+2h

# Update the summary of an existing event
curl --request PUT http://localhost:3000/caldav/default/4e87c316-053a-11f1-8340-2c98113d4945.ics -H "Content-Type: text/calendar" --upload-file /dev/stdin <<-EOF
BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:what is up?
END:VEVENT
END:VCALENDAR
EOF

```

#### API Endpoints

**GET /** - API information and available endpoints

**GET /health** - Health check endpoint

```bash
curl http://localhost:3000/health
```

**POST /parse** - Parse ICS content to JMAP format

```bash
# Send ICS as text
curl -X POST http://localhost:3000/parse \
  -H "Content-Type: text/plain" \
  --data-binary @calendar.ics

# Send ICS in JSON body
curl -X POST http://localhost:3000/parse \
  -H "Content-Type: application/json" \
  -d '{"ics": "BEGIN:VCALENDAR\n..."}'
```

**POST /validate** - Validate ICS content

```bash
curl -X POST http://localhost:3000/validate \
  -H "Content-Type: text/plain" \
  --data-binary @calendar.ics
```

**POST /stats** - Get statistics about ICS content

```bash
curl -X POST http://localhost:3000/stats \
  -H "Content-Type: text/plain" \
  --data-binary @calendar.ics
```

**POST /parse/event/:uid** - Get a specific event by UID

```bash
curl -X POST http://localhost:3000/parse/event/event-123 \
  -H "Content-Type: text/plain" \
  --data-binary @calendar.ics
```

#### Calendar Store Endpoints

The server includes an in-memory store using Automerge CRDTs. The store maintains a global map of calendar documents, where each calendar is a separate Automerge CRDT document matching the JMAP Calendar type. Events are stored within their respective calendars.

**Calendar Management:**

**GET /store/calendars** - List all calendars

```bash
curl http://localhost:3000/store/calendars
```

**POST /store/calendars** - Create a new calendar

```bash
curl -X POST http://localhost:3000/store/calendars \
  -H "Content-Type: application/json" \
  -d '{
    "id": "work",
    "name": "Work Calendar",
    "description": "Work-related events",
    "color": "#FF5733"
  }'
```

**GET /store/calendars/:calendarId** - Get a specific calendar

```bash
curl http://localhost:3000/store/calendars/work
```

**PUT /store/calendars/:calendarId** - Update a calendar

```bash
curl -X PUT http://localhost:3000/store/calendars/work \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Work Calendar",
    "color": "#3498DB"
  }'
```

**DELETE /store/calendars/:calendarId** - Delete a calendar

```bash
curl -X DELETE http://localhost:3000/store/calendars/work
```

**Event Management:**

**GET /store/events** - List all events across all calendars

```bash
curl http://localhost:3000/store/events
```

**POST /store/events** - Add an event to the Default Automerge Calendar

```bash
curl -X POST http://localhost:3000/store/events \
  -H "Content-Type: application/json" \
  -d '{
    "@type": "CalendarEvent",
    "uid": "my-event-123",
    "title": "Team Meeting",
    "start": "2024-01-15T14:00:00"
  }'
```

Note: Events are added to the "default" calendar unless otherwise specified.

**GET /store/events/:uid** - Get a specific event from the store

```bash
curl http://localhost:3000/store/events/my-event-123
```

**PUT /store/events/:uid** - Update an event in the store

```bash
curl -X PUT http://localhost:3000/store/events/my-event-123 \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Updated Meeting Title",
    "description": "New description"
  }'
```

**DELETE /store/events/:uid** - Delete an event from the store

```bash
curl -X DELETE http://localhost:3000/store/events/my-event-123
```

**POST /store/import** - Import parsed ICS events into the store

```bash
curl -X POST http://localhost:3000/store/import \
  -H "Content-Type: text/plain" \
  --data-binary @calendar.ics
```

**DELETE /store/clear** - Clear all events from the store

```bash
curl -X DELETE http://localhost:3000/store/clear
```

#### CalDAV Protocol Endpoints

The server implements CalDAV protocol support, allowing standard calendar clients (Apple Calendar, Thunderbird, etc.) to connect and sync with the calendar store.

**Base CalDAV URL:** `http://localhost:3000/caldav/`

**Supported CalDAV Methods:**

**PROPFIND** - Discover calendars and list events

```bash
curl -X PROPFIND http://localhost:3000/caldav/ \
  -H "Depth: 1" \
  -H "Content-Type: application/xml"
```

**MKCALENDAR** - Create a new calendar

```bash
curl -X MKCALENDAR http://localhost:3000/caldav/my-calendar/
```

**GET** - Retrieve calendar or event in iCalendar format

```bash
# Get all events from a calendar
curl http://localhost:3000/caldav/default/

# Get a specific event
curl http://localhost:3000/caldav/default/event-123.ics
```

**PUT** - Create or update an event (iCalendar format)

```bash
curl -X PUT http://localhost:3000/caldav/default/new-event.ics \
  -H "Content-Type: text/calendar" \
  --data-binary @event.ics
```

**DELETE** - Delete a calendar or event

```bash
# Delete an event
curl -X DELETE http://localhost:3000/caldav/default/event-123.ics

# Delete a calendar
curl -X DELETE http://localhost:3000/caldav/my-calendar/
```

**REPORT** - Query calendar data with filtering

```bash
curl -X REPORT http://localhost:3000/caldav/default/ \
  -H "Content-Type: application/xml" \
  -H "Depth: 1"
```

**Connecting Calendar Clients:**

To connect a CalDAV client (Apple Calendar, Thunderbird, etc.):

- Server URL: `http://localhost:3000/caldav/`
- Calendar Path: `/caldav/{calendar-id}/`
- No authentication required (basic implementation)

### Parsing ICS Files (Programmatic)

```typescript
import { icsToEvent } from "./src/parser";
import * as fs from "fs";

// Read an .ics file
const icsContent = fs.readFileSync("calendar.ics", "utf-8");

// Parse to JMAP format
const events = icsToEvent(icsContent);

console.log(events);
```

### Example Output

```typescript
[
  {
    "@type": "CalendarEvent",
    uid: "event-123",
    title: "Team Meeting",
    description: "Weekly team sync",
    start: "2024-01-15T14:00:00",
    timeZone: "America/New_York",
    duration: "PT1H",
    locations: {
      "location-1": {
        "@type": "Location",
        name: "Conference Room A",
      },
    },
    participants: {
      "organizer-0": {
        "@type": "Participant",
        name: "John Doe",
        email: "john@example.com",
        roles: { owner: true },
      },
    },
  },
];
```

## Supported Features

### Basic Properties

- ✅ Title (SUMMARY)
- ✅ Description (DESCRIPTION)
- ✅ Start time (DTSTART)
- ✅ Duration (DURATION / DTEND)
- ✅ Timezone support
- ✅ All-day events
- ✅ Timestamps (CREATED, LAST-MODIFIED, DTSTAMP)
- ✅ Sequence numbers
- ✅ Priority

### Status & Classification

- ✅ Event status (CONFIRMED, CANCELLED, TENTATIVE)
- ✅ Free/Busy status (TRANSP)
- ✅ Privacy (CLASS)
- ✅ Color

### Participants

- ✅ Organizer (ORGANIZER)
- ✅ Attendees (ATTENDEE)
- ✅ Participation status (PARTSTAT)
- ✅ Roles
- ✅ RSVP expectations

### Locations

- ✅ Physical locations (LOCATION)
- ✅ Virtual locations (CONFERENCE, URL)
- ✅ Auto-detection of Zoom, Google Meet, Teams links

### Recurrence

- ✅ Recurrence rules (RRULE)
- ✅ All frequencies (DAILY, WEEKLY, MONTHLY, YEARLY, etc.)
- ✅ BYDAY, BYMONTH, BYMONTHDAY rules
- ✅ Count and UNTIL
- ✅ Exception dates (EXDATE)
- ✅ Additional dates (RDATE)

### Alarms

- ✅ Offset triggers (relative to start/end)
- ✅ Absolute triggers
- ✅ Display and Email actions

### Other

- ✅ Categories (CATEGORIES)
- ✅ Attachments (ATTACH)
- ✅ Links (URL)
- ✅ Multiple events per calendar

## Development

### Running the Server

Development mode (with auto-reload and HTTP request logging):

```bash
npm run dev
# or
NODE_ENV=development npm start
```

When running in development mode (NODE_ENV !== 'production'), all HTTP requests are logged to the console:

```
→ GET /health
← GET /health 200 1ms
→ POST /store/events
← POST /store/events 201 5ms
```

Production mode (no request logging):

```bash
npm run build
npm start
```

### Build

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### VSCode Debugging

The project includes VSCode debug configurations in `.vscode/launch.json`. Available debug configurations:

**Debug Server (Development)** - Run the server with full debugging support

- Press `F5` or use the "Debug Server (Development)" configuration
- Runs with `NODE_ENV=development` automatically
- Source maps enabled for TypeScript debugging
- HTTP request logging enabled
- Set breakpoints directly in `.ts` files

**Debug Tests** - Debug all tests

- Use the "Debug Tests" configuration
- Runs Jest with `--runInBand` for sequential execution
- Breakpoints work in both source and test files

**Debug Current Test File** - Debug only the currently open test file

- Open a test file (e.g., `tests/parser.test.ts`)
- Use the "Debug Current Test File" configuration
- Great for focused debugging

**Keyboard Shortcuts:**

- `F5` - Start debugging
- `F9` - Toggle breakpoint
- `F10` - Step over
- `F11` - Step into
- `Shift+F11` - Step out

### Testing

Run all tests:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Generate coverage report:

```bash
npm run test:coverage
```

### API Testing with REST Client

The project includes an `api-requests.http` file with pre-configured API requests for all endpoints. If you have the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) extension installed in VSCode:

1. Open `api-requests.http`
2. Click "Send Request" above any request
3. View the response in a new panel

The file includes examples for:

- All REST API endpoints (parsing, validation, store operations)
- Calendar management (create, update, delete calendars)
- Event management (CRUD operations)
- CalDAV protocol methods (PROPFIND, REPORT, MKCALENDAR, etc.)

**Tip:** Make sure the server is running (`npm run dev`) before sending requests!

### Test Coverage

The test suite includes **69 comprehensive tests** covering:

**Parser Tests (19 tests):**

- Basic event parsing
- Status and classification
- Participants (organizers and attendees)
- Recurrence rules
- Alarms/reminders
- Virtual locations (Zoom, Meet, Teams)
- Multiple events
- Edge cases
- Categories and attachments

**Calendar Store Tests (38 tests):**

- Adding single and multiple events
- Retrieving events by UID
- Listing all events
- Updating events
- Deleting events
- Filtering events
- Clearing the store
- Calendar management (create, read, update, delete)
- Multi-calendar event management
- Automerge CRDT integration

**Server API Tests (12 tests):**

- API information endpoints
- Health checks
- ICS parsing endpoints
- Validation endpoint
- Statistics endpoint
- Event retrieval by UID
- Store CRUD operations
- Import functionality
- Error handling

## Examples

See the `examples/` directory for usage examples:

- **api-example.sh** - Shell script with curl examples for parsing ICS files

  ```bash
  ./examples/api-example.sh
  ```

- **api-client.js** - Node.js client example for parsing ICS files

  ```bash
  node examples/api-client.js
  ```

- **store-example.js** - Node.js example demonstrating the calendar store API
  ```bash
  node examples/store-example.js
  ```

## Project Structure

```
automerge-calendar/
├── src/
│   ├── jmap-types.ts        # JMAP type definitions
│   ├── parser.ts            # ICS to JMAP parser
│   ├── calendar-store.ts    # Automerge-based event store
│   ├── caldav-handler.ts    # CalDAV protocol handler
│   └── server.ts            # Express web server
├── examples/
│   ├── api-example.sh       # Shell/curl examples for parsing
│   ├── api-client.js        # Node.js parsing client example
│   └── store-example.js     # Node.js store API example
├── tests/
│   ├── parser.test.ts       # Parser test suite
│   ├── calendar-store.test.ts  # Store test suite
│   └── server.test.ts       # Server API test suite
├── dist/                    # Compiled JavaScript output
├── jest.config.js           # Jest configuration
├── tsconfig.json            # TypeScript configuration
└── package.json
```

## Type Safety

The parser includes robust type checking with custom ensure functions:

```typescript
ensureString(); // Validates string types
ensureTime(); // Validates ICAL.Time types
ensureNumber(); // Validates number types
ensureDuration(); // Validates ICAL.Duration types
ensureRecur(); // Validates ICAL.Recur types
```

These functions:

- Return the typed value if valid
- Return `undefined` for null/undefined inputs
- Throw descriptive errors for type mismatches

## Standards

This implementation is based on:

- **JSCalendar**: RFC 8984
- **JMAP for Calendars**: RFC 8984
- **iCalendar**: RFC 5545
- **iCalendar Extensions**: RFC 7986
- **CalDAV**: RFC 4791 (Calendaring Extensions to WebDAV)

## Dependencies

### Runtime Dependencies

- `ical.js` - iCalendar parsing and generation
- `express` - Web server framework
- `cors` - Cross-Origin Resource Sharing support
- `@automerge/automerge` - Automerge CRDT library
- `xml2js` - XML parsing for CalDAV
- `fast-xml-parser` - Fast XML parsing

### Development Dependencies

- `typescript` - Type safety and compilation
- `jest` - Testing framework
- `ts-jest` - TypeScript support for Jest
- `supertest` - HTTP API testing
- `nodemon` - Development auto-reload
- `ts-node` - TypeScript execution

## License

ISC
