describe('Calendar View', () => {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let calId: string;

  function switchToDayView() {
    cy.get('.sx__view-selection-selected-item').click();
    cy.get('.sx__view-selection-items').contains('Day').click();
    cy.get('.sx__time-grid-day', { timeout: 5000 }).should('exist');
  }

  function visitCalendar() {
    cy.visit(`/calendars/${calId}`);
    cy.get('#sx-cal', { timeout: 10000 }).should('not.be.empty');
  }

  // Helper: select a value from a Radix UI Select component by trigger ID
  function radixSelect(triggerId: string, label: string) {
    cy.get(`#${triggerId}`).click();
    cy.get('[role="listbox"]').should('be.visible');
    cy.contains('[role="option"]', label).click();
  }

  before(() => {
    // Use the default calendar (server creates one on startup with clean data dir)
    cy.request('GET', '/api/docs').then((res) => {
      const cal = res.body.find((d: any) => d.type === 'Calendar');
      calId = cal?.documentId ?? res.body[0].documentId;
    });
  });

  beforeEach(() => {
    // Reset events before each test so tests are independent
    cy.request('POST', `/api/docs/${calId}/reset`);
    visitCalendar();
  });

  it('renders with correct page title', () => {
    cy.title().should('eq', 'Default Automerge Calendar - Calendar');
  });

  it('hides the loading status after calendar loads', () => {
    cy.get('#status').should('not.exist');
  });

  it('renders the schedule-x calendar container', () => {
    cy.get('#sx-cal').children().should('have.length.greaterThan', 0);
  });

  it('displays an event created via the API', () => {
    const uid = 'cy-display-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Visible Event',
          start: dateStr + 'T10:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Visible Event').should('exist');
  });

  it('opens the editor panel when clicking an event', () => {
    const uid = 'cy-click-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Click Target',
          start: dateStr + 'T14:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Click Target').click({ force: true });

    cy.get('.panel').should('be.visible');
    cy.get('.overlay').should('exist');
    cy.get('#ed-title').should('have.value', 'Click Target');
  });

  it('closes the editor panel when clicking cancel', () => {
    const uid = 'cy-cancel-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Cancel Test',
          start: dateStr + 'T11:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Cancel Test').click({ force: true });
    cy.get('.panel').should('be.visible');
    cy.get('#ed-cancel').click();
    cy.get('.panel').should('not.exist');
    cy.get('.overlay').should('not.exist');
  });

  it('closes the editor panel when clicking the overlay', () => {
    const uid = 'cy-overlay-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Overlay Test',
          start: dateStr + 'T12:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Overlay Test').click({ force: true });
    cy.get('.panel').should('be.visible');
    cy.get('.overlay').click({ force: true });
    cy.get('.panel').should('not.exist');
  });

  it('edits an event title through the editor', () => {
    const uid = 'cy-edit-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Original Title',
          start: dateStr + 'T15:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Original Title').click({ force: true });
    cy.get('#ed-title').clear().type('Updated Title');
    cy.get('#ed-save').click();

    cy.get('.panel').should('not.exist');
    cy.contains('Updated Title').should('exist');
  });

  it('creates a new event via the editor', () => {
    switchToDayView();
    cy.get('.sx__time-grid-day').click(50, 200, { force: true });
    cy.get('.panel').should('be.visible');
    cy.get('.panel h2').should('contain', 'New Event');

    cy.get('#ed-title').type('Brand New Event');
    cy.get('#ed-date').clear().type(dateStr);
    // Ensure all-day is unchecked (Radix Checkbox — click only if checked)
    cy.get('#ed-allday').then($el => {
      if ($el.attr('data-state') === 'checked') cy.wrap($el).click();
    });
    cy.get('#ed-time').clear().type('16:00');
    cy.get('#ed-duration').clear().type('PT2H');
    cy.get('#ed-save').click();

    cy.get('.panel').should('not.exist');
    cy.contains('Brand New Event').should('exist');
  });

  it('shows the all-day checkbox and hides time fields when checked', () => {
    const uid = 'cy-allday-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'All Day Toggle',
          start: dateStr + 'T09:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('All Day Toggle').click({ force: true });

    cy.get('#time-fields').should('exist');
    // Check all-day (Radix Checkbox — click to toggle)
    cy.get('#ed-allday').click();
    cy.get('#time-fields').should('not.exist');
    // Uncheck all-day
    cy.get('#ed-allday').click();
    cy.get('#time-fields').should('exist');
  });

  it('shows recurrence options when frequency is selected', () => {
    const uid = 'cy-recur-ui-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Recurrence UI Test',
          start: dateStr + 'T10:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Recurrence UI Test').click({ force: true });

    cy.get('#recurrence-opts').should('not.exist');
    radixSelect('ed-freq', 'Weekly');
    cy.get('#recurrence-opts').should('exist');
    cy.get('#weekly-days').should('exist');
    cy.get('.day-btn').should('have.length', 7);

    radixSelect('ed-freq', 'Daily');
    cy.get('#weekly-days').should('not.exist');

    radixSelect('ed-freq', 'None');
    cy.get('#recurrence-opts').should('not.exist');
  });

  it('toggles day buttons in weekly recurrence', () => {
    const uid = 'cy-days-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Day Toggle Test',
          start: dateStr + 'T10:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Day Toggle Test').click({ force: true });

    radixSelect('ed-freq', 'Weekly');
    cy.get('.day-btn').eq(1).click();
    cy.get('.day-btn').eq(1).should('have.class', 'active');
    cy.get('.day-btn').eq(1).click();
    cy.get('.day-btn').eq(1).should('not.have.class', 'active');
  });

  it('creates a recurring event and verifies multiple instances via API', () => {
    const uid = 'cy-recur-' + Date.now();
    const start = new Date(today);
    start.setDate(start.getDate() - 3);
    const startStr = start.toISOString().substring(0, 10);

    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Recurring Check',
          start: startStr + 'T09:00:00',
          duration: 'PT15M',
          timeZone: null,
          recurrenceRule: {
            '@type': 'RecurrenceRule',
            frequency: 'daily',
          },
        },
      },
    }).then((response) => {
      expect(response.body.events[uid].recurrenceRule).to.exist;
      expect(response.body.events[uid].recurrenceRule.frequency).to.eq('daily');
    });

    visitCalendar();
    switchToDayView();
    cy.contains('Recurring Check').should('exist');
  });

  it('shows "Edit Occurrence" when clicking a recurring event instance', () => {
    const uid = 'cy-occur-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Recurring Click',
          start: dateStr + 'T13:00:00',
          duration: 'PT30M',
          timeZone: null,
          recurrenceRule: {
            '@type': 'RecurrenceRule',
            frequency: 'daily',
          },
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Recurring Click').first().click({ force: true });

    cy.get('.panel h2').should('contain', 'Edit Occurrence');
    cy.contains('Edit all events').should('exist');
  });

  it('switches to edit-all mode for a recurring event', () => {
    const uid = 'cy-editall-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Edit All Test',
          start: dateStr + 'T11:00:00',
          duration: 'PT1H',
          timeZone: null,
          recurrenceRule: {
            '@type': 'RecurrenceRule',
            frequency: 'weekly',
          },
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Edit All Test', { timeout: 10000 }).first().click({ force: true });
    cy.get('.panel h2').should('contain', 'Edit Occurrence');

    cy.contains('Edit all events').click();
    cy.get('.panel h2').should('contain', 'Edit Event');
    cy.get('#ed-freq').should('contain.text', 'Weekly');
  });

  it('populates location and description in the editor', () => {
    const uid = 'cy-fields-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'Full Event',
          start: dateStr + 'T16:00:00',
          duration: 'PT1H',
          timeZone: null,
          location: 'Room 42',
          description: 'Discuss quarterly results',
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('Full Event', { timeout: 10000 }).click({ force: true });

    cy.get('#ed-location').should('have.value', 'Room 42');
    cy.get('#ed-desc').should('have.value', 'Discuss quarterly results');
  });

  it('renders an all-day event in the date grid strip', () => {
    const uid = 'cy-allday-render-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'All Day Meeting',
          start: dateStr,
          duration: 'P1D',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.get('.sx__date-grid-event', { timeout: 10000 }).should('exist');
    cy.contains('All Day Meeting').should('exist');
  });

  it('shows recurrence end options (count and until)', () => {
    const uid = 'cy-ends-' + Date.now();
    cy.request('PATCH', `/docs/${calId}`, {
      events: {
        [uid]: {
          '@type': 'Event',
          title: 'End Options',
          start: dateStr + 'T10:00:00',
          duration: 'PT1H',
          timeZone: null,
        },
      },
    });
    visitCalendar();
    switchToDayView();
    cy.contains('End Options', { timeout: 10000 }).click({ force: true });
    radixSelect('ed-freq', 'Daily');

    cy.get('#ed-ends').should('contain.text', 'Never');
    cy.get('#end-count').should('not.exist');
    cy.get('#end-until').should('not.exist');

    radixSelect('ed-ends', 'After');
    cy.get('#end-count').should('exist');
    cy.get('#ed-count').should('exist');

    radixSelect('ed-ends', 'On date');
    cy.get('#end-until').should('exist');
    cy.get('#ed-until').should('exist');
  });
});
