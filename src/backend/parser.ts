import ICAL from "ical.js"
import type {
  CalendarEvent,
  RecurrenceRule,
  NDay,
} from '../shared/schemas'
import type {
  PatchObject,
  Participant,
  VirtualLocation,
  Alert,
  OffsetTrigger,
  AbsoluteTrigger,
  Link,
  Duration,
  UTCDateTime,
  LocalDateTime,
} from '../shared/schemas/core'

function ensureString<T>(v: T): string | undefined {
  if (v === undefined || v === null) {
    return undefined
  }
  if (typeof v === "string") {
    return v
  }
  throw new Error(`Expected string but got ${typeof v}`)
}

function ensureTime<T>(v: T): ICAL.Time | undefined {
  if (v === undefined || v === null) {
    return undefined
  }
  if (v instanceof ICAL.Time) {
    return v
  }
  throw new Error(`Expected ICAL.Time but got ${typeof v}`)
}

function ensureNumber<T>(v: T): number | undefined {
  if (v === undefined || v === null) {
    return undefined
  }
  if (typeof v === "number") {
    return v
  }
  throw new Error(`Expected number but got ${typeof v}`)
}

function ensureDuration<T>(v: T): ICAL.Duration | undefined {
  if (v === undefined || v === null) {
    return undefined
  }
  if (v instanceof ICAL.Duration) {
    return v
  }
  throw new Error(`Expected ICAL.Duration but got ${typeof v}`)
}

function ensureRecur<T>(v: T): ICAL.Recur | undefined {
  if (v === undefined || v === null) {
    return undefined
  }
  if (v instanceof ICAL.Recur) {
    return v
  }
  throw new Error(`Expected ICAL.Recur but got ${typeof v}`)
}

/**
 * Parses an .ics file content and converts it to JMAP CalendarEvent format
 * @param icsContent - The raw .ics file content as a string
 * @returns Array of objects containing uid and CalendarEvent
 */
export function icsToEvent(icsContent: string): Array<{ uid: string; event: CalendarEvent }> {
  const jcalData = ICAL.parse(icsContent)
  const comp = new ICAL.Component(jcalData)

  const parsed: Array<{ uid: string; event: CalendarEvent }> = []
  const vevents = comp.getAllSubcomponents("vevent")

  for (const vevent of vevents) {
    parsed.push(parseVEventToJMAP(vevent))
  }

  // Group by UID and merge exception VEVENTs into parent
  const byUid = new Map<string, { uid: string; event: CalendarEvent }[]>()
  for (const entry of parsed) {
    const group = byUid.get(entry.uid)
    if (group) {
      group.push(entry)
    } else {
      byUid.set(entry.uid, [entry])
    }
  }

  const events: Array<{ uid: string; event: CalendarEvent }> = []
  for (const [uid, group] of byUid) {
    if (group.length === 1) {
      // Single VEVENT — no merging needed
      const { event } = group[0]
      delete event.recurrenceId
      delete event.recurrenceIdTimeZone
      events.push({ uid, event })
      continue
    }

    // Find parent (no recurrenceId) and exceptions
    const parent = group.find(e => !e.event.recurrenceId)
    if (!parent) {
      // No parent found — treat all as separate events
      events.push(...group)
      continue
    }

    if (!parent.event.recurrenceOverrides) {
      parent.event.recurrenceOverrides = {}
    }

    for (const exception of group) {
      if (exception === parent) continue
      const recurrenceId = exception.event.recurrenceId!
      const patch = computeOverridePatch(parent.event, exception.event)
      parent.event.recurrenceOverrides[recurrenceId] = patch
    }

    delete parent.event.recurrenceId
    delete parent.event.recurrenceIdTimeZone
    events.push({ uid, event: parent.event })
  }

  return events
}

/**
 * Compute a patch object representing what changed in an exception vs the parent.
 * Returns only the properties that differ.
 */
function computeOverridePatch(parent: CalendarEvent, exception: CalendarEvent): PatchObject {
  // If exception is cancelled, treat as exclusion
  if (exception.status === 'cancelled') {
    return { excluded: true }
  }

  const patch: Record<string, any> = {}
  const propsToCompare: (keyof CalendarEvent)[] = [
    'title', 'description', 'start', 'timeZone', 'duration',
    'status', 'location', 'virtualLocations', 'participants',
    'alerts', 'categories', 'privacy', 'freeBusyStatus',
  ]

  for (const key of propsToCompare) {
    const parentVal = parent[key]
    const exceptionVal = exception[key]

    if (exceptionVal === undefined) continue

    if (JSON.stringify(parentVal) !== JSON.stringify(exceptionVal)) {
      patch[key] = exceptionVal
    }
  }

  return Object.keys(patch).length > 0 ? patch : {}
}

/**
 * Converts a single VEVENT component to a JMAP CalendarEvent
 */
function parseVEventToJMAP(vevent: ICAL.Component): { uid: string; event: CalendarEvent } {
  const uid = ensureString(vevent.getFirstPropertyValue("uid"))!
  const event: CalendarEvent = {
    "@type": "Event",
  }

  // Basic properties
  parseBasicProperties(vevent, event)

  // Time properties
  parseTimeProperties(vevent, event)

  // Recurrence
  parseRecurrence(vevent, event)

  // Recurrence ID (for exception instances)
  const recurrenceIdTime = ensureTime(vevent.getFirstPropertyValue("recurrence-id"))
  if (recurrenceIdTime) {
    event.recurrenceId = icalTimeToLocal(recurrenceIdTime)
    const recIdProp = vevent.getFirstProperty("recurrence-id")
    const recIdTzid = ensureString(recIdProp?.getParameter("tzid"))
    event.recurrenceIdTimeZone = recIdTzid || null
  }

  // Participants
  parseParticipants(vevent, event)

  // Locations
  parseLocations(vevent, event)

  // Alerts/Alarms
  parseAlerts(vevent, event)

  // Attachments
  parseAttachments(vevent, event)

  // Status and classification
  parseStatus(vevent, event)

  // Categories and keywords
  parseCategories(vevent, event)

  // Links
  parseLinks(vevent, event)

  return { uid, event }
}

/**
 * Parse basic event properties
 */
function parseBasicProperties(vevent: ICAL.Component, event: CalendarEvent): void {
  // Title
  const summary = ensureString(vevent.getFirstPropertyValue("summary"))
  if (summary) {
    event.title = summary
  }

  // Description
  const description = ensureString(vevent.getFirstPropertyValue("description"))
  if (description) {
    event.description = description
  }

  // Timestamps
  const created = ensureTime(vevent.getFirstPropertyValue("created"))
  if (created) {
    event.created = icalTimeToUTC(created)
  }

  // const lastModified = ensureTime(vevent.getFirstPropertyValue("last-modified"))
  // if (lastModified) {
  //   event.updated = icalTimeToUTC(lastModified)
  // }

  // const dtstamp = ensureTime(vevent.getFirstPropertyValue("dtstamp"))
  // if (dtstamp && !event.updated) {
  //   event.updated = icalTimeToUTC(dtstamp)
  // }

  // Sequence — ignored (managed by CalDAV clients, not stored)

  // Priority
  const priority = ensureNumber(vevent.getFirstPropertyValue("priority"))
  if (priority !== undefined) {
    event.priority = priority
  }
}

/**
 * Parse time-related properties
 */
function parseTimeProperties(vevent: ICAL.Component, event: CalendarEvent): void {
  const dtstartTime = ensureTime(vevent.getFirstPropertyValue("dtstart"))
  if (dtstartTime) {
    const dtstartProp = vevent.getFirstProperty("dtstart")
    const tzid = ensureString(dtstartProp?.getParameter("tzid"))

    if (dtstartTime.isDate) {
      // All-day event
      event.start = icalDateToLocal(dtstartTime)
      event.timeZone = null
    } else if (tzid) {
      // Event with explicit timezone
      event.start = icalTimeToLocal(dtstartTime)
      event.timeZone = tzid
    } else if (dtstartTime.zone === ICAL.Timezone.utcTimezone) {
      // Explicit UTC
      event.start = icalTimeToLocal(dtstartTime)
      event.timeZone = "Etc/UTC"
    } else {
      // Floating time
      event.start = icalTimeToLocal(dtstartTime)
      event.timeZone = null
    }
  }

  // Duration or end time
  const duration = ensureDuration(vevent.getFirstPropertyValue("duration"))
  if (duration) {
    event.duration = icalDurationToISO(duration)
  } else {
    const dtendTime = ensureTime(vevent.getFirstPropertyValue("dtend"))
    if (dtendTime && dtstartTime) {
      // Calculate duration from start and end
      const dur = dtendTime.subtractDate(dtstartTime)
      event.duration = icalDurationToISO(dur)
    }
  }
}

/**
 * Parse recurrence rules
 */
function parseRecurrence(vevent: ICAL.Component, event: CalendarEvent): void {
  const rruleProp = vevent.getFirstProperty("rrule")
  if (rruleProp) {
    const rrule = ensureRecur(rruleProp.getFirstValue())
    if (rrule) {
      event.recurrenceRule = parseRRule(rrule)
    }
  }

  // EXDATE (recurrence overrides for excluded dates)
  const exdates = vevent.getAllProperties("exdate")
  if (exdates.length > 0) {
    event.recurrenceOverrides = {}
    for (const exdateProp of exdates) {
      const exdate = ensureTime(exdateProp.getFirstValue())
      if (exdate) {
        const dateKey = icalTimeToLocal(exdate)
        event.recurrenceOverrides[dateKey] = { excluded: true }
      }
    }
  }

  // RDATE (additional recurrence dates)
  const rdates = vevent.getAllProperties("rdate")
  for (const rdateProp of rdates) {
    const rdate = ensureTime(rdateProp.getFirstValue())
    if (rdate) {
      const dateKey = icalTimeToLocal(rdate)
      if (!event.recurrenceOverrides) {
        event.recurrenceOverrides = {}
      }
      // RDATE adds an instance, not excluding it
      event.recurrenceOverrides[dateKey] = {}
    }
  }
}

/**
 * Convert ICAL recurrence rule to JMAP RecurrenceRule
 */
function parseRRule(rrule: ICAL.Recur): RecurrenceRule {
  const rule: RecurrenceRule = {
    "@type": "RecurrenceRule",
    frequency: mapFrequency(rrule.freq),
  }

  if (rrule.interval && rrule.interval > 1) {
    rule.interval = rrule.interval
  }

  if (rrule.count) {
    rule.count = rrule.count
  }

  if (rrule.until) {
    rule.until = icalTimeToLocal(rrule.until)
  }

  // By-rules
  if (rrule.parts.BYDAY && rrule.parts.BYDAY.length > 0) {
    rule.byDay = rrule.parts.BYDAY.map(parseByDay)
  }

  if (rrule.parts.BYMONTHDAY && rrule.parts.BYMONTHDAY.length > 0) {
    rule.byMonthDay = rrule.parts.BYMONTHDAY
  }

  if (rrule.parts.BYMONTH && rrule.parts.BYMONTH.length > 0) {
    rule.byMonth = rrule.parts.BYMONTH.map(m => m.toString())
  }

  if (rrule.parts.BYYEARDAY && rrule.parts.BYYEARDAY.length > 0) {
    rule.byYearDay = rrule.parts.BYYEARDAY
  }

  if (rrule.parts.BYWEEKNO && rrule.parts.BYWEEKNO.length > 0) {
    rule.byWeekNo = rrule.parts.BYWEEKNO
  }

  if (rrule.parts.BYHOUR && rrule.parts.BYHOUR.length > 0) {
    rule.byHour = rrule.parts.BYHOUR
  }

  if (rrule.parts.BYMINUTE && rrule.parts.BYMINUTE.length > 0) {
    rule.byMinute = rrule.parts.BYMINUTE
  }

  if (rrule.parts.BYSECOND && rrule.parts.BYSECOND.length > 0) {
    rule.bySecond = rrule.parts.BYSECOND
  }

  if (rrule.parts.BYSETPOS && rrule.parts.BYSETPOS.length > 0) {
    rule.bySetPosition = rrule.parts.BYSETPOS
  }

  if (rrule.wkst) {
    rule.firstDayOfWeek = mapWeekday(rrule.wkst)
  }

  return rule
}

/**
 * Parse BYDAY values (e.g., "1MO", "-1FR")
 */
function parseByDay(byday: string | number): NDay {
  const str = byday.toString()
  const match = str.match(/^(-?\d+)?([A-Z]{2})$/)

  if (!match) {
    throw new Error(`Invalid BYDAY value: ${byday}`)
  }

  const nday: NDay = {
    "@type": "NDay",
    day: mapWeekday(ICAL.Recur.icalDayToNumericDay(match[2])),
  }

  if (match[1]) {
    nday.nthOfPeriod = parseInt(match[1], 10)
  }

  return nday
}

/**
 * Map ICAL frequency to JMAP frequency
 */
function mapFrequency(freq: string): RecurrenceRule["frequency"] {
  const freqMap: { [key: string]: RecurrenceRule["frequency"] } = {
    YEARLY: "yearly",
    MONTHLY: "monthly",
    WEEKLY: "weekly",
    DAILY: "daily",
    HOURLY: "hourly",
    MINUTELY: "minutely",
    SECONDLY: "secondly",
  }
  return freqMap[freq] || "daily"
}

/**
 * Map numeric day to JMAP weekday format
 */
function mapWeekday(day: number): NDay["day"] {
  const dayMap: { [key: number]: NDay["day"] } = {
    1: "su",
    2: "mo",
    3: "tu",
    4: "we",
    5: "th",
    6: "fr",
    7: "sa",
  }
  return dayMap[day] || "mo"
}

/**
 * Parse participants (attendees and organizer)
 */
function parseParticipants(vevent: ICAL.Component, event: CalendarEvent): void {
  const participants: { [key: string]: Participant } = {}
  let participantId = 0

  // Organizer
  const organizerProp = vevent.getFirstProperty("organizer")
  if (organizerProp) {
    const organizer = parseParticipant(organizerProp, true)
    participants[`organizer-${participantId++}`] = organizer
  }

  // Attendees
  const attendees = vevent.getAllProperties("attendee")
  for (const attendeeProp of attendees) {
    const attendee = parseParticipant(attendeeProp, false)
    participants[`attendee-${participantId++}`] = attendee
  }

  if (Object.keys(participants).length > 0) {
    event.participants = participants
  }
}

/**
 * Parse a single participant from organizer or attendee property
 */
function parseParticipant(prop: ICAL.Property, isOrganizer: boolean): Participant {
  const participant: Participant = {
    "@type": "Participant",
    roles: isOrganizer ? { owner: true } : { attendee: true },
  }

  const value = ensureString(prop.getFirstValue())
  if (value) {
    const email = value.replace(/^mailto:/i, "")
    participant.email = email
    participant.sendTo = { imip: value.toLowerCase().startsWith("mailto:") ? value : `mailto:${email}` }
  }

  const cn = ensureString(prop.getParameter("cn"))
  if (cn) {
    participant.name = cn
  }

  if (!isOrganizer) {
    const partstat = ensureString(prop.getParameter("partstat"))
    if (partstat) {
      participant.participationStatus = mapPartStat(partstat)
    }

    const role = ensureString(prop.getParameter("role"))
    if (role) {
      participant.roles = { [role.toLowerCase()]: true }
    }

    const cutype = ensureString(prop.getParameter("cutype"))
    if (cutype) {
      participant.kind = mapCuType(cutype)
    }

    const rsvp = ensureString(prop.getParameter("rsvp"))
    if (rsvp) {
      participant.expectReply = rsvp.toUpperCase() === "TRUE"
    }
  }

  return participant
}

/**
 * Map PARTSTAT values to JMAP participation status
 */
function mapPartStat(partstat: string): Participant["participationStatus"] {
  const statusMap: { [key: string]: Participant["participationStatus"] } = {
    "NEEDS-ACTION": "needs-action",
    ACCEPTED: "accepted",
    DECLINED: "declined",
    TENTATIVE: "tentative",
    DELEGATED: "delegated",
  }
  return statusMap[partstat.toUpperCase()] || "needs-action"
}

/**
 * Map CUTYPE values to JMAP participant kind
 */
function mapCuType(cutype: string): Participant["kind"] {
  const typeMap: { [key: string]: Participant["kind"] } = {
    INDIVIDUAL: "individual",
    GROUP: "group",
    RESOURCE: "resource",
    ROOM: "room",
  }
  return typeMap[cutype.toUpperCase()] || "individual"
}

/**
 * Parse location information
 */
function parseLocations(vevent: ICAL.Component, event: CalendarEvent): void {
  const locationProp = vevent.getFirstProperty("location")
  if (locationProp) {
    const locationText = ensureString(locationProp.getFirstValue())
    if (locationText) {
      event.location = locationText
    }
  }

  // Check for virtual locations (conference property from RFC 7986)
  const conferenceProp = vevent.getFirstProperty("conference")
  if (conferenceProp) {
    const uri = ensureString(conferenceProp.getFirstValue())
    if (uri) {
      const label = ensureString(conferenceProp.getParameter("label"))
      event.virtualLocations = {
        "virtual-1": {
          "@type": "VirtualLocation",
          uri: uri,
          name: label || "Virtual Meeting",
        },
      }
    }
  }

  // Parse URL as potential virtual location
  const urlStr = ensureString(vevent.getFirstPropertyValue("url"))
  if (urlStr && !event.virtualLocations) {
    if (urlStr.includes("zoom") || urlStr.includes("meet") || urlStr.includes("teams")) {
      event.virtualLocations = {
        "virtual-1": {
          "@type": "VirtualLocation",
          uri: urlStr,
          name: "Virtual Meeting",
        },
      }
    }
  }
}

/**
 * Parse alerts (alarms)
 */
function parseAlerts(vevent: ICAL.Component, event: CalendarEvent): void {
  const valarms = vevent.getAllSubcomponents("valarm")
  if (valarms.length > 0) {
    event.alerts = {}
    for (let i = 0; i < valarms.length; i++) {
      const valarm = valarms[i]
      const alert = parseAlarm(valarm)
      if (alert) {
        event.alerts[`alarm-${i + 1}`] = alert
      }
    }
  }
}

/**
 * Parse a single VALARM component
 */
function parseAlarm(valarm: ICAL.Component): Alert | null {
  const action = valarm.getFirstPropertyValue("action")
  const trigger = valarm.getFirstPropertyValue("trigger")

  if (!trigger) {
    return null
  }

  const alert: Alert = {
    "@type": "Alert",
    trigger: { "@type": "OffsetTrigger", offset: "PT0S" },
  }

  // Parse trigger
  if (trigger instanceof ICAL.Duration) {
    const offset = icalDurationToISO(trigger)
    const related = valarm.getFirstProperty("trigger")?.getParameter("related")
    alert.trigger = {
      "@type": "OffsetTrigger",
      offset: offset,
      relativeTo: related === "END" ? "end" : "start",
    } as OffsetTrigger
  } else if (trigger instanceof ICAL.Time) {
    alert.trigger = {
      "@type": "AbsoluteTrigger",
      when: icalTimeToUTC(trigger),
    } as AbsoluteTrigger
  }

  // Parse action
  const actionStr = ensureString(action)
  if (actionStr) {
    const actionLower = actionStr.toLowerCase()
    if (actionLower === "display" || actionLower === "email") {
      alert.action = actionLower
    }
  }

  return alert
}

/**
 * Parse attachments
 */
function parseAttachments(vevent: ICAL.Component, event: CalendarEvent): void {
  const attachProps = vevent.getAllProperties("attach")
  if (attachProps.length > 0) {
    event.attachments = {}
    for (let i = 0; i < attachProps.length; i++) {
      const attachProp = attachProps[i]
      const href = ensureString(attachProp.getFirstValue())
      if (href) {
        const link: Link = {
          "@type": "Link",
          href: href,
        }

        const fmttype = ensureString(attachProp.getParameter("fmttype"))
        if (fmttype) {
          link.contentType = fmttype
        }

        const filename = ensureString(attachProp.getParameter("filename"))
        if (filename) {
          link.title = filename
        }

        event.attachments[`attachment-${i + 1}`] = link
      }
    }
  }
}

/**
 * Parse status and classification
 */
function parseStatus(vevent: ICAL.Component, event: CalendarEvent): void {
  const status = ensureString(vevent.getFirstPropertyValue("status"))
  if (status) {
    const statusLower = status.toLowerCase()
    if (statusLower === "confirmed" || statusLower === "cancelled" || statusLower === "tentative") {
      event.status = statusLower
    }
  }

  const transp = ensureString(vevent.getFirstPropertyValue("transp"))
  if (transp) {
    event.freeBusyStatus = transp.toUpperCase() === "TRANSPARENT" ? "free" : "busy"
  }

  const classValue = ensureString(vevent.getFirstPropertyValue("class"))
  if (classValue) {
    const classLower = classValue.toLowerCase()
    if (classLower === "public" || classLower === "private" || classLower === "confidential") {
      event.privacy = classLower as CalendarEvent["privacy"]
    }
  }

  const color = ensureString(vevent.getFirstPropertyValue("color"))
  if (color) {
    event.color = color
  }
}

/**
 * Parse categories and keywords
 */
function parseCategories(vevent: ICAL.Component, event: CalendarEvent): void {
  const categoryProps = vevent.getAllProperties("categories")
  if (categoryProps.length > 0) {
    event.categories = {}
    for (const prop of categoryProps) {
      const categories = prop.getValues()
      const catArray = Array.isArray(categories) ? categories : [categories]
      for (const cat of catArray) {
        const catStr = ensureString(cat)
        if (catStr) {
          event.categories[catStr] = true
        }
      }
    }
  }
}

/**
 * Parse links (URL property)
 */
function parseLinks(vevent: ICAL.Component, event: CalendarEvent): void {
  const url = ensureString(vevent.getFirstPropertyValue("url"))
  if (url) {
    event.links = {
      "link-1": {
        "@type": "Link",
        href: url,
      },
    }
  }
}

/**
 * Convert ICAL.Time to UTC datetime string
 */
function icalTimeToUTC(time: ICAL.Time): UTCDateTime {
  return time.toJSDate().toISOString()
}

/**
 * Convert ICAL.Time to local datetime string
 */
function icalTimeToLocal(time: ICAL.Time): LocalDateTime {
  // Format as ISO 8601 local datetime
  const year = time.year.toString().padStart(4, "0")
  const month = (time.month).toString().padStart(2, "0")
  const day = time.day.toString().padStart(2, "0")
  const hour = time.hour.toString().padStart(2, "0")
  const minute = time.minute.toString().padStart(2, "0")
  const second = time.second.toString().padStart(2, "0")

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

/**
 * Convert ICAL date (no time) to local date string
 */
function icalDateToLocal(time: ICAL.Time): LocalDateTime {
  const year = time.year.toString().padStart(4, "0")
  const month = (time.month).toString().padStart(2, "0")
  const day = time.day.toString().padStart(2, "0")

  return `${year}-${month}-${day}`
}

/**
 * Convert ICAL.Duration to ISO 8601 duration string
 */
function icalDurationToISO(duration: ICAL.Duration): Duration {
  let result = duration.isNegative ? "-P" : "P"

  if (duration.weeks > 0) {
    result += `${duration.weeks}W`
  } else {
    if (duration.days > 0) {
      result += `${duration.days}D`
    }

    if (duration.hours > 0 || duration.minutes > 0 || duration.seconds > 0) {
      result += "T"
      if (duration.hours > 0) {
        result += `${duration.hours}H`
      }
      if (duration.minutes > 0) {
        result += `${duration.minutes}M`
      }
      if (duration.seconds > 0) {
        result += `${duration.seconds}S`
      }
    }
  }

  // Handle edge case of zero duration
  if (result === "P" || result === "-P") {
    result = "PT0S"
  }

  return result
}

