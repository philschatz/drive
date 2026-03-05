import ICAL from "ical.js"
import type {
  CalendarEvent,
  RecurrenceRule,
  NDay,
} from './schemas'
import type {
  PatchObject,
  Participant,
  Alert,
  OffsetTrigger,
  AbsoluteTrigger,
  Link,
  Duration,
  UTCDateTime,
  LocalDateTime,
} from './schemas/core'

function ensureString<T>(v: T): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === "string") return v
  throw new Error(`Expected string but got ${typeof v}`)
}

function ensureTime<T>(v: T): ICAL.Time | undefined {
  if (v === undefined || v === null) return undefined
  if (v instanceof ICAL.Time) return v
  throw new Error(`Expected ICAL.Time but got ${typeof v}`)
}

function ensureNumber<T>(v: T): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === "number") return v
  throw new Error(`Expected number but got ${typeof v}`)
}

function ensureDuration<T>(v: T): ICAL.Duration | undefined {
  if (v === undefined || v === null) return undefined
  if (v instanceof ICAL.Duration) return v
  throw new Error(`Expected ICAL.Duration but got ${typeof v}`)
}

function ensureRecur<T>(v: T): ICAL.Recur | undefined {
  if (v === undefined || v === null) return undefined
  if (v instanceof ICAL.Recur) return v
  throw new Error(`Expected ICAL.Recur but got ${typeof v}`)
}

export function icsToEvent(icsContent: string): Array<{ uid: string; event: CalendarEvent }> {
  const jcalData = ICAL.parse(icsContent)
  const comp = new ICAL.Component(jcalData)

  const parsed: Array<{ uid: string; event: CalendarEvent }> = []
  const vevents = comp.getAllSubcomponents("vevent")

  for (const vevent of vevents) {
    parsed.push(parseVEventToJMAP(vevent))
  }

  const byUid = new Map<string, { uid: string; event: CalendarEvent }[]>()
  for (const entry of parsed) {
    const group = byUid.get(entry.uid)
    if (group) group.push(entry)
    else byUid.set(entry.uid, [entry])
  }

  const events: Array<{ uid: string; event: CalendarEvent }> = []
  for (const [uid, group] of byUid) {
    if (group.length === 1) {
      const { event } = group[0]
      delete event.recurrenceId
      delete event.recurrenceIdTimeZone
      events.push({ uid, event })
      continue
    }
    const parent = group.find(e => !e.event.recurrenceId)
    if (!parent) { events.push(...group); continue }
    if (!parent.event.recurrenceOverrides) parent.event.recurrenceOverrides = {}
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

function computeOverridePatch(parent: CalendarEvent, exception: CalendarEvent): PatchObject {
  if (exception.status === 'cancelled') return { excluded: true }
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
    if (JSON.stringify(parentVal) !== JSON.stringify(exceptionVal)) patch[key] = exceptionVal
  }
  return Object.keys(patch).length > 0 ? patch : {}
}

function parseVEventToJMAP(vevent: ICAL.Component): { uid: string; event: CalendarEvent } {
  const uid = ensureString(vevent.getFirstPropertyValue("uid"))!
  const event: CalendarEvent = { "@type": "Event" }
  parseBasicProperties(vevent, event)
  parseTimeProperties(vevent, event)
  parseRecurrence(vevent, event)
  const recurrenceIdTime = ensureTime(vevent.getFirstPropertyValue("recurrence-id"))
  if (recurrenceIdTime) {
    event.recurrenceId = icalTimeToLocal(recurrenceIdTime)
    const recIdProp = vevent.getFirstProperty("recurrence-id")
    const recIdTzid = ensureString(recIdProp?.getParameter("tzid"))
    event.recurrenceIdTimeZone = recIdTzid || null
  }
  parseParticipants(vevent, event)
  parseLocations(vevent, event)
  parseAlerts(vevent, event)
  parseAttachments(vevent, event)
  parseStatus(vevent, event)
  parseCategories(vevent, event)
  parseLinks(vevent, event)
  return { uid, event }
}

function parseBasicProperties(vevent: ICAL.Component, event: CalendarEvent): void {
  const summary = ensureString(vevent.getFirstPropertyValue("summary"))
  if (summary) event.title = summary
  const description = ensureString(vevent.getFirstPropertyValue("description"))
  if (description) event.description = description
  const created = ensureTime(vevent.getFirstPropertyValue("created"))
  if (created) event.created = icalTimeToUTC(created)
  const priority = ensureNumber(vevent.getFirstPropertyValue("priority"))
  if (priority !== undefined) event.priority = priority
}

function parseTimeProperties(vevent: ICAL.Component, event: CalendarEvent): void {
  const dtstartTime = ensureTime(vevent.getFirstPropertyValue("dtstart"))
  if (dtstartTime) {
    const dtstartProp = vevent.getFirstProperty("dtstart")
    const tzid = ensureString(dtstartProp?.getParameter("tzid"))
    if (dtstartTime.isDate) {
      event.start = icalDateToLocal(dtstartTime)
      event.timeZone = null
    } else if (tzid) {
      event.start = icalTimeToLocal(dtstartTime)
      event.timeZone = tzid
    } else if (dtstartTime.zone === ICAL.Timezone.utcTimezone) {
      event.start = icalTimeToLocal(dtstartTime)
      event.timeZone = "Etc/UTC"
    } else {
      event.start = icalTimeToLocal(dtstartTime)
      event.timeZone = null
    }
  }
  const duration = ensureDuration(vevent.getFirstPropertyValue("duration"))
  if (duration) {
    event.duration = icalDurationToISO(duration)
  } else {
    const dtendTime = ensureTime(vevent.getFirstPropertyValue("dtend"))
    if (dtendTime && dtstartTime) {
      const dur = dtendTime.subtractDate(dtstartTime)
      event.duration = icalDurationToISO(dur)
    }
  }
}

function parseRecurrence(vevent: ICAL.Component, event: CalendarEvent): void {
  const rruleProp = vevent.getFirstProperty("rrule")
  if (rruleProp) {
    const rrule = ensureRecur(rruleProp.getFirstValue())
    if (rrule) event.recurrenceRule = parseRRule(rrule)
  }
  const exdates = vevent.getAllProperties("exdate")
  if (exdates.length > 0) {
    event.recurrenceOverrides = {}
    for (const exdateProp of exdates) {
      const exdate = ensureTime(exdateProp.getFirstValue())
      if (exdate) event.recurrenceOverrides[icalTimeToLocal(exdate)] = { excluded: true }
    }
  }
  const rdates = vevent.getAllProperties("rdate")
  for (const rdateProp of rdates) {
    const rdate = ensureTime(rdateProp.getFirstValue())
    if (rdate) {
      if (!event.recurrenceOverrides) event.recurrenceOverrides = {}
      event.recurrenceOverrides[icalTimeToLocal(rdate)] = {}
    }
  }
}

function parseRRule(rrule: ICAL.Recur): RecurrenceRule {
  const rule: RecurrenceRule = { "@type": "RecurrenceRule", frequency: mapFrequency(rrule.freq) }
  if (rrule.interval && rrule.interval > 1) rule.interval = rrule.interval
  if (rrule.count) rule.count = rrule.count
  if (rrule.until) rule.until = icalTimeToLocal(rrule.until)
  const p = rrule.parts as Record<string, any[] | undefined>
  if (p.BYDAY?.length) rule.byDay = p.BYDAY.map(parseByDay)
  if (p.BYMONTHDAY?.length) rule.byMonthDay = p.BYMONTHDAY as number[]
  if (p.BYMONTH?.length) rule.byMonth = (p.BYMONTH as number[]).map((m) => m.toString())
  if (p.BYYEARDAY?.length) rule.byYearDay = p.BYYEARDAY as number[]
  if (p.BYWEEKNO?.length) rule.byWeekNo = p.BYWEEKNO as number[]
  if (p.BYHOUR?.length) rule.byHour = p.BYHOUR as number[]
  if (p.BYMINUTE?.length) rule.byMinute = p.BYMINUTE as number[]
  if (p.BYSECOND?.length) rule.bySecond = p.BYSECOND as number[]
  if (p.BYSETPOS?.length) rule.bySetPosition = p.BYSETPOS as number[]
  if (rrule.wkst) rule.firstDayOfWeek = mapWeekday(rrule.wkst)
  return rule
}

function parseByDay(byday: string | number): NDay {
  const str = byday.toString()
  const match = str.match(/^(-?\d+)?([A-Z]{2})$/)
  if (!match) throw new Error(`Invalid BYDAY value: ${byday}`)
  const nday: NDay = { "@type": "NDay", day: mapWeekday(ICAL.Recur.icalDayToNumericDay(match[2])) }
  if (match[1]) nday.nthOfPeriod = parseInt(match[1], 10)
  return nday
}

function mapFrequency(freq: string): RecurrenceRule["frequency"] {
  const freqMap: { [key: string]: RecurrenceRule["frequency"] } = {
    YEARLY: "yearly", MONTHLY: "monthly", WEEKLY: "weekly", DAILY: "daily",
    HOURLY: "hourly", MINUTELY: "minutely", SECONDLY: "secondly",
  }
  return freqMap[freq] || "daily"
}

function mapWeekday(day: number): NDay["day"] {
  const dayMap: { [key: number]: NDay["day"] } = {
    1: "su", 2: "mo", 3: "tu", 4: "we", 5: "th", 6: "fr", 7: "sa",
  }
  return dayMap[day] || "mo"
}

function parseParticipants(vevent: ICAL.Component, event: CalendarEvent): void {
  const participants: { [key: string]: Participant } = {}
  let participantId = 0
  const organizerProp = vevent.getFirstProperty("organizer")
  if (organizerProp) participants[`organizer-${participantId++}`] = parseParticipant(organizerProp, true)
  for (const attendeeProp of vevent.getAllProperties("attendee")) {
    participants[`attendee-${participantId++}`] = parseParticipant(attendeeProp, false)
  }
  if (Object.keys(participants).length > 0) event.participants = participants
}

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
  if (cn) participant.name = cn
  if (!isOrganizer) {
    const partstat = ensureString(prop.getParameter("partstat"))
    if (partstat) participant.participationStatus = mapPartStat(partstat)
    const role = ensureString(prop.getParameter("role"))
    if (role) participant.roles = { [role.toLowerCase()]: true }
    const cutype = ensureString(prop.getParameter("cutype"))
    if (cutype) participant.kind = mapCuType(cutype)
    const rsvp = ensureString(prop.getParameter("rsvp"))
    if (rsvp) participant.expectReply = rsvp.toUpperCase() === "TRUE"
  }
  return participant
}

function mapPartStat(partstat: string): Participant["participationStatus"] {
  const statusMap: { [key: string]: Participant["participationStatus"] } = {
    "NEEDS-ACTION": "needs-action", ACCEPTED: "accepted", DECLINED: "declined",
    TENTATIVE: "tentative", DELEGATED: "delegated",
  }
  return statusMap[partstat.toUpperCase()] || "needs-action"
}

function mapCuType(cutype: string): Participant["kind"] {
  const typeMap: { [key: string]: Participant["kind"] } = {
    INDIVIDUAL: "individual", GROUP: "group", RESOURCE: "resource", ROOM: "room",
  }
  return typeMap[cutype.toUpperCase()] || "individual"
}

function parseLocations(vevent: ICAL.Component, event: CalendarEvent): void {
  const locationProp = vevent.getFirstProperty("location")
  if (locationProp) {
    const locationText = ensureString(locationProp.getFirstValue())
    if (locationText) event.location = locationText
  }
  const conferenceProp = vevent.getFirstProperty("conference")
  if (conferenceProp) {
    const uri = ensureString(conferenceProp.getFirstValue())
    if (uri) {
      event.virtualLocations = {
        "virtual-1": {
          "@type": "VirtualLocation",
          uri,
          name: ensureString(conferenceProp.getParameter("label")) || "Virtual Meeting",
        },
      }
    }
  }
  const urlStr = ensureString(vevent.getFirstPropertyValue("url"))
  if (urlStr && !event.virtualLocations) {
    if (urlStr.includes("zoom") || urlStr.includes("meet") || urlStr.includes("teams")) {
      event.virtualLocations = { "virtual-1": { "@type": "VirtualLocation", uri: urlStr, name: "Virtual Meeting" } }
    }
  }
}

function parseAlerts(vevent: ICAL.Component, event: CalendarEvent): void {
  const valarms = vevent.getAllSubcomponents("valarm")
  if (valarms.length > 0) {
    event.alerts = {}
    for (let i = 0; i < valarms.length; i++) {
      const alert = parseAlarm(valarms[i])
      if (alert) event.alerts[`alarm-${i + 1}`] = alert
    }
  }
}

function parseAlarm(valarm: ICAL.Component): Alert | null {
  const action = valarm.getFirstPropertyValue("action")
  const trigger = valarm.getFirstPropertyValue("trigger")
  if (!trigger) return null
  const alert: Alert = { "@type": "Alert", trigger: { "@type": "OffsetTrigger", offset: "PT0S" } }
  if (trigger instanceof ICAL.Duration) {
    const offset = icalDurationToISO(trigger)
    const related = valarm.getFirstProperty("trigger")?.getParameter("related")
    alert.trigger = { "@type": "OffsetTrigger", offset, relativeTo: related === "END" ? "end" : "start" } as OffsetTrigger
  } else if (trigger instanceof ICAL.Time) {
    alert.trigger = { "@type": "AbsoluteTrigger", when: icalTimeToUTC(trigger) } as AbsoluteTrigger
  }
  const actionStr = ensureString(action)
  if (actionStr) {
    const actionLower = actionStr.toLowerCase()
    if (actionLower === "display" || actionLower === "email") alert.action = actionLower
  }
  return alert
}

function parseAttachments(vevent: ICAL.Component, event: CalendarEvent): void {
  const attachProps = vevent.getAllProperties("attach")
  if (attachProps.length > 0) {
    event.attachments = {}
    for (let i = 0; i < attachProps.length; i++) {
      const href = ensureString(attachProps[i].getFirstValue())
      if (href) {
        const link: Link = { "@type": "Link", href }
        const fmttype = ensureString(attachProps[i].getParameter("fmttype"))
        if (fmttype) link.contentType = fmttype
        const filename = ensureString(attachProps[i].getParameter("filename"))
        if (filename) link.title = filename
        event.attachments[`attachment-${i + 1}`] = link
      }
    }
  }
}

function parseStatus(vevent: ICAL.Component, event: CalendarEvent): void {
  const status = ensureString(vevent.getFirstPropertyValue("status"))
  if (status) {
    const s = status.toLowerCase()
    if (s === "confirmed" || s === "cancelled" || s === "tentative") event.status = s
  }
  const transp = ensureString(vevent.getFirstPropertyValue("transp"))
  if (transp) event.freeBusyStatus = transp.toUpperCase() === "TRANSPARENT" ? "free" : "busy"
  const classValue = ensureString(vevent.getFirstPropertyValue("class"))
  if (classValue) {
    const c = classValue.toLowerCase()
    if (c === "public" || c === "private" || c === "confidential") event.privacy = c as CalendarEvent["privacy"]
  }
  const color = ensureString(vevent.getFirstPropertyValue("color"))
  if (color) event.color = color
}

function parseCategories(vevent: ICAL.Component, event: CalendarEvent): void {
  const categoryProps = vevent.getAllProperties("categories")
  if (categoryProps.length > 0) {
    event.categories = {}
    for (const prop of categoryProps) {
      const categories = prop.getValues()
      const catArray = Array.isArray(categories) ? categories : [categories]
      for (const cat of catArray) {
        const catStr = ensureString(cat)
        if (catStr) event.categories[catStr] = true
      }
    }
  }
}

function parseLinks(vevent: ICAL.Component, event: CalendarEvent): void {
  const url = ensureString(vevent.getFirstPropertyValue("url"))
  if (url) event.links = { "link-1": { "@type": "Link", href: url } }
}

function icalTimeToUTC(time: ICAL.Time): UTCDateTime {
  return time.toJSDate().toISOString()
}

function icalTimeToLocal(time: ICAL.Time): LocalDateTime {
  const year = time.year.toString().padStart(4, "0")
  const month = (time.month).toString().padStart(2, "0")
  const day = time.day.toString().padStart(2, "0")
  const hour = time.hour.toString().padStart(2, "0")
  const minute = time.minute.toString().padStart(2, "0")
  const second = time.second.toString().padStart(2, "0")
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

function icalDateToLocal(time: ICAL.Time): LocalDateTime {
  const year = time.year.toString().padStart(4, "0")
  const month = (time.month).toString().padStart(2, "0")
  const day = time.day.toString().padStart(2, "0")
  return `${year}-${month}-${day}`
}

function icalDurationToISO(duration: ICAL.Duration): Duration {
  let result = duration.isNegative ? "-P" : "P"
  if (duration.weeks > 0) {
    result += `${duration.weeks}W`
  } else {
    if (duration.days > 0) result += `${duration.days}D`
    if (duration.hours > 0 || duration.minutes > 0 || duration.seconds > 0) {
      result += "T"
      if (duration.hours > 0) result += `${duration.hours}H`
      if (duration.minutes > 0) result += `${duration.minutes}M`
      if (duration.seconds > 0) result += `${duration.seconds}S`
    }
  }
  if (result === "P" || result === "-P") result = "PT0S"
  return result
}
