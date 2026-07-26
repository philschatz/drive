import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, radixSelect, type App } from './support';

/**
 * Calendar editor UI test (ported from cypress/e2e/calendar.cy.ts). Consolidated
 * into one sequential test that preserves the original cross-`it` dependency
 * chain: create "Brand New Event" -> rename to "Updated Title" -> exercise
 * all-day / recurrence / end-option toggles on it -> create the recurring,
 * full, and all-day events.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Calendar', () => {
  let app: App;

  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const waitForCalendar = () =>
    expect(app.page.locator('.sx__calendar-wrapper')).toBeVisible({ timeout: 30_000 });

  async function switchToDayView() {
    const page = app.page;
    await page.locator('.sx__view-selection-selected-item').click();
    await page.locator('.sx__view-selection-items').getByText('Day').click();
    await expect(page.locator('.sx__time-grid-day')).toBeVisible({ timeout: 5_000 });
  }

  async function setAllDay(checked: boolean) {
    const el = app.page.locator('#ed-allday');
    const isChecked = (await el.getAttribute('data-state')) === 'checked';
    if (checked !== isChecked) await el.click();
  }

  async function createEvent(opts: {
    title: string;
    date?: string;
    time?: string;
    duration?: string;
    allDay?: boolean;
    location?: string;
    description?: string;
    frequency?: string;
  }) {
    const page = app.page;
    await switchToDayView();
    await page.locator('.sx__time-grid-day').click({ position: { x: 50, y: 200 }, force: true });
    await expect(page.locator('.panel')).toBeVisible();

    await page.locator('#ed-title').fill(opts.title);
    if (opts.date) await page.locator('#ed-date').fill(opts.date);

    if (opts.allDay) {
      await setAllDay(true);
    } else {
      await setAllDay(false);
      if (opts.time) await page.locator('#ed-time').fill(opts.time);
      if (opts.duration) await page.locator('#ed-duration').fill(opts.duration);
    }

    if (opts.location) await page.locator('#ed-location').fill(opts.location);
    if (opts.description) await page.locator('#ed-desc').fill(opts.description);
    if (opts.frequency) await radixSelect(page, 'ed-freq', opts.frequency);

    await page.locator('#ed-save').click();
    await expect(page.locator('.panel')).toHaveCount(0);
  }

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'calendar');
    await createDocViaUI(app, 'Calendar', 'Test Calendar');
    await waitForCalendar();
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  test('calendar editor', async () => {
    const page = app.page;

    // Loading status gone; schedule-x container populated
    await expect(page.locator('#status')).toHaveCount(0);
    expect(await page.locator('#sx-cal > *').count()).toBeGreaterThan(0);

    // Create an event via the editor
    await createEvent({ title: 'Brand New Event', date: dateStr, time: '16:00', duration: 'PT2H' });
    await switchToDayView();
    await expect(page.getByText('Brand New Event').first()).toBeVisible();

    // Open the editor by clicking the event; title is populated
    await page.getByText('Brand New Event').first().click({ force: true });
    await expect(page.locator('.panel')).toBeVisible();
    await expect(page.locator('#ed-title')).toHaveValue('Brand New Event');
    await page.locator('#ed-cancel').click();

    // Cancel closes panel + overlay
    await page.getByText('Brand New Event').first().click({ force: true });
    await expect(page.locator('.panel')).toBeVisible();
    await page.locator('#ed-cancel').click();
    await expect(page.locator('.panel')).toHaveCount(0);
    await expect(page.locator('.overlay')).toHaveCount(0);

    // Overlay click closes panel
    await page.getByText('Brand New Event').first().click({ force: true });
    await expect(page.locator('.panel')).toBeVisible();
    // Click near the top of the overlay — the editor is a bottom sheet now, so
    // the overlay's center is covered by sheet content (a force-click there
    // would land on the sheet and not dismiss).
    await page.locator('.overlay').click({ force: true, position: { x: 10, y: 10 } });
    await expect(page.locator('.panel')).toHaveCount(0);

    // Edit the title -> "Updated Title"
    await page.getByText('Brand New Event').first().click({ force: true });
    await page.locator('#ed-title').fill('Updated Title');
    await page.locator('#ed-save').click();
    await expect(page.locator('.panel')).toHaveCount(0);
    await expect(page.getByText('Updated Title').first()).toBeVisible();

    // All-day checkbox hides time fields
    await switchToDayView();
    await page.getByText('Updated Title').first().click({ force: true });
    await expect(page.locator('#time-fields')).toBeVisible();
    await page.locator('#ed-allday').click();
    await expect(page.locator('#time-fields')).toHaveCount(0);
    await page.locator('#ed-allday').click();
    await expect(page.locator('#time-fields')).toBeVisible();
    await page.locator('#ed-cancel').click();

    // Recurrence options appear/disappear with frequency
    await switchToDayView();
    await page.getByText('Updated Title').first().click({ force: true });
    await expect(page.locator('#recurrence-opts')).toHaveCount(0);
    await radixSelect(page, 'ed-freq', 'Weekly');
    await expect(page.locator('#recurrence-opts')).toBeVisible();
    await expect(page.locator('#weekly-days')).toBeVisible();
    await expect(page.locator('.day-btn')).toHaveCount(7);
    await radixSelect(page, 'ed-freq', 'Daily');
    await expect(page.locator('#weekly-days')).toHaveCount(0);
    await radixSelect(page, 'ed-freq', 'None');
    await expect(page.locator('#recurrence-opts')).toHaveCount(0);
    await page.locator('#ed-cancel').click();

    // Toggle weekly day buttons
    await switchToDayView();
    await page.getByText('Updated Title').first().click({ force: true });
    await radixSelect(page, 'ed-freq', 'Weekly');
    const day = page.locator('.day-btn').nth(1);
    await day.click();
    await expect(day).toHaveClass(/active/);
    await day.click();
    await expect(day).not.toHaveClass(/active/);
    await page.locator('#ed-cancel').click();

    // Recurrence end options (count + until) on a daily event
    await switchToDayView();
    await page.getByText('Updated Title').first().click({ force: true });
    await radixSelect(page, 'ed-freq', 'Daily');
    await expect(page.locator('#ed-ends')).toContainText('Never');
    await expect(page.locator('#end-count')).toHaveCount(0);
    await expect(page.locator('#end-until')).toHaveCount(0);
    await radixSelect(page, 'ed-ends', 'After');
    await expect(page.locator('#end-count')).toBeVisible();
    await expect(page.locator('#ed-count')).toBeVisible();
    await radixSelect(page, 'ed-ends', 'On date');
    await expect(page.locator('#end-until')).toBeVisible();
    await expect(page.locator('#ed-until')).toBeVisible();
    await page.locator('#ed-cancel').click();

    // Create a recurring event
    await createEvent({ title: 'Recurring Check', date: dateStr, time: '09:00', duration: 'PT15M', frequency: 'Daily' });
    await switchToDayView();
    await expect(page.getByText('Recurring Check').first()).toBeVisible();

    // Recurring instance shows "Edit Occurrence" + "Edit all events"
    await page.getByText('Recurring Check').first().click({ force: true });
    await expect(page.locator('.panel h2')).toContainText('Edit Occurrence');
    await expect(page.getByText('Edit all events')).toBeVisible();
    // Switch to edit-all mode
    await page.getByText('Edit all events').click();
    await expect(page.locator('.panel h2')).toContainText('Edit Event');
    await expect(page.locator('#ed-freq')).toContainText('Daily');
    await page.locator('#ed-cancel').click();

    // Populate location + description
    await createEvent({
      title: 'Full Event',
      date: dateStr,
      time: '14:00',
      duration: 'PT1H',
      location: 'Room 42',
      description: 'Discuss quarterly results',
    });
    await switchToDayView();
    await page.getByText('Full Event').first().click({ force: true });
    await expect(page.locator('#ed-location')).toHaveValue('Room 42');
    await expect(page.locator('#ed-desc')).toHaveValue('Discuss quarterly results');
    await page.locator('#ed-cancel').click();

    // All-day event renders in the date-grid strip
    await createEvent({ title: 'All Day Meeting', date: dateStr, allDay: true });
    await switchToDayView();
    await expect(page.locator('.sx__date-grid-event')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('All Day Meeting').first()).toBeVisible();
  });
});
