import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, mdSelect, mdField, openProperty, backToProperties, type App } from './support';

/**
 * Calendar editor UI test (ported from cypress/e2e/calendar.cy.ts). Consolidated
 * into one sequential test that preserves the original cross-`it` dependency
 * chain: create "Brand New Event" -> rename to "Updated Title" -> exercise
 * all-day / recurrence / end-option toggles on it -> create the recurring,
 * full, and all-day events.
 *
 * The editor is a PropertySheet: it opens on a list of properties and shows one
 * property's fields at a time, so each interaction taps its row first
 * (`openProperty`) and pops back with `backToProperties`. Date/time/all-day/
 * duration share the "When" row; the whole recurrence rule shares "Repeat".
 * It also auto-saves — every field commits on blur/change, there is no
 * Save/Cancel, and closing the sheet is the only "done" gesture.
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

  /** Close the editor — the X, since there is no Cancel button any more. */
  async function closeEditor() {
    await app.page.locator('.panel').getByRole('button', { name: 'Close' }).click();
    await expect(app.page.locator('.panel')).toHaveCount(0);
  }

  /** Toggle all-day; assumes the "When" pane is already open. */
  async function setAllDay(checked: boolean) {
    const el = app.page.locator('#ed-allday');
    const isChecked = (await el.getAttribute('data-state')) === 'checked';
    if (checked !== isChecked) await el.click();
  }

  /** Open an existing event from the day grid, landing on its property list. */
  async function openEvent(title: string) {
    await app.page.getByText(title).first().click({ force: true });
    await expect(app.page.locator('.panel')).toBeVisible();
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

    // A new event opens straight in the Title pane.
    await mdField(page, 'ed-title').fill(opts.title);
    await backToProperties(page);

    await openProperty(page, 'ed-when');
    if (opts.date) await mdField(page, 'ed-date').fill(opts.date);
    if (opts.allDay) {
      await setAllDay(true);
    } else {
      await setAllDay(false);
      if (opts.time) await mdField(page, 'ed-time').fill(opts.time);
      if (opts.duration) await mdField(page, 'ed-duration').fill(opts.duration);
    }
    await backToProperties(page);

    if (opts.location) {
      await openProperty(page, 'ed-location');
      await mdField(page, 'ed-location').fill(opts.location);
      await backToProperties(page);
    }
    if (opts.description) {
      await openProperty(page, 'ed-desc');
      await mdField(page, 'ed-desc').fill(opts.description);
      await backToProperties(page);
    }
    if (opts.frequency) {
      await openProperty(page, 'ed-repeat');
      await mdSelect(page, 'ed-freq', opts.frequency);
      await backToProperties(page);
    }

    // Auto-save: everything is already written; closing is the done gesture.
    await closeEditor();
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

    // Open the editor by clicking the event; the Title row summarises the value,
    // and its pane holds it.
    await openEvent('Brand New Event');
    await expect(page.getByTestId('ed-title-row')).toContainText('Brand New Event');
    await openProperty(page, 'ed-title');
    await expect(mdField(page, 'ed-title')).toHaveValue('Brand New Event');
    await closeEditor();

    // Overlay click closes the panel
    await openEvent('Brand New Event');
    // Click near the top of the overlay — the editor is a bottom sheet, so the
    // overlay's center is covered by sheet content (a force-click there would
    // land on the sheet and not dismiss).
    await page.locator('.overlay').click({ force: true, position: { x: 10, y: 10 } });
    await expect(page.locator('.panel')).toHaveCount(0);

    // Escape inside a detail pane pops back to the list rather than closing
    await openEvent('Brand New Event');
    await openProperty(page, 'ed-title');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ed-title-row')).toBeVisible();
    await expect(page.locator('.panel')).toBeVisible();
    // …and Escape on the list closes the sheet.
    await page.keyboard.press('Escape');
    await expect(page.locator('.panel')).toHaveCount(0);

    // Edit the title -> "Updated Title". Auto-save: blurring the field writes it.
    await openEvent('Brand New Event');
    await openProperty(page, 'ed-title');
    await mdField(page, 'ed-title').fill('Updated Title');
    await backToProperties(page);
    await expect(page.getByTestId('ed-title-row')).toContainText('Updated Title');
    await closeEditor();
    await expect(page.getByText('Updated Title').first()).toBeVisible();

    // All-day checkbox hides time fields (both live in the When pane)
    await switchToDayView();
    await openEvent('Updated Title');
    await openProperty(page, 'ed-when');
    await expect(page.locator('#time-fields')).toBeVisible();
    await page.locator('#ed-allday').click();
    await expect(page.locator('#time-fields')).toHaveCount(0);
    await page.locator('#ed-allday').click();
    await expect(page.locator('#time-fields')).toBeVisible();
    await closeEditor();

    // Recurrence options appear/disappear with frequency
    await switchToDayView();
    await openEvent('Updated Title');
    // The collapsed row summarises the rule before you open it.
    await expect(page.getByTestId('ed-repeat-row')).toContainText('Never');
    await openProperty(page, 'ed-repeat');
    await expect(page.locator('#recurrence-opts')).toHaveCount(0);
    await mdSelect(page, 'ed-freq', 'Weekly');
    await expect(page.locator('#recurrence-opts')).toBeVisible();
    await expect(page.locator('#weekly-days')).toBeVisible();
    await expect(page.locator('.day-btn')).toHaveCount(7);
    await mdSelect(page, 'ed-freq', 'Daily');
    await expect(page.locator('#weekly-days')).toHaveCount(0);

    // Toggle a weekly day button
    await mdSelect(page, 'ed-freq', 'Weekly');
    const day = page.locator('.day-btn').nth(1);
    await day.click();
    await expect(day).toHaveClass(/active/);
    await day.click();
    await expect(day).not.toHaveClass(/active/);

    // Recurrence end options (count + until) on a daily event
    await mdSelect(page, 'ed-freq', 'Daily');
    await expect(page.locator('#ed-ends')).toHaveJSProperty('value', 'never');
    await expect(page.locator('#end-count')).toHaveCount(0);
    await expect(page.locator('#end-until')).toHaveCount(0);
    await mdSelect(page, 'ed-ends', 'After');
    await expect(page.locator('#end-count')).toBeVisible();
    await expect(page.locator('#ed-count')).toBeVisible();
    await mdSelect(page, 'ed-ends', 'On date');
    await expect(page.locator('#end-until')).toBeVisible();
    await expect(page.locator('#ed-until')).toBeVisible();

    // Back to non-recurring so the later assertions start from a clean event.
    await mdSelect(page, 'ed-freq', 'None');
    await expect(page.locator('#recurrence-opts')).toHaveCount(0);
    await closeEditor();

    // Create a recurring event
    await createEvent({ title: 'Recurring Check', date: dateStr, time: '09:00', duration: 'PT15M', frequency: 'Daily' });
    await switchToDayView();
    await expect(page.getByText('Recurring Check').first()).toBeVisible();

    // Recurring instance shows "Edit Occurrence" + a full-width "Edit all events"
    // row. The Repeat row is hidden on an occurrence — it can't change the
    // series' rule.
    await openEvent('Recurring Check');
    await expect(page.locator('.panel h2')).toContainText('Edit Occurrence');
    await expect(page.getByTestId('ed-repeat-row')).toHaveCount(0);
    await page.getByTestId('ed-edit-all').click();
    await expect(page.locator('.panel h2')).toContainText('Edit Event');
    await expect(page.getByTestId('ed-repeat-row')).toContainText('daily');
    await closeEditor();

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
    await openEvent('Full Event');
    // The list surfaces both values without opening anything.
    await expect(page.getByTestId('ed-location-row')).toContainText('Room 42');
    await expect(page.getByTestId('ed-desc-row')).toContainText('Discuss quarterly results');
    await openProperty(page, 'ed-location');
    await expect(mdField(page, 'ed-location')).toHaveValue('Room 42');
    await closeEditor();

    // All-day event renders in the date-grid strip
    await createEvent({ title: 'All Day Meeting', date: dateStr, allDay: true });
    await switchToDayView();
    await expect(page.locator('.sx__date-grid-event')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('All Day Meeting').first()).toBeVisible();
  });
});
