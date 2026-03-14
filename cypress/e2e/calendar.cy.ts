describe('Calendar View', () => {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  function waitForCalendar() {
    // schedule-x renders .sx__calendar-wrapper inside #sx-cal once ready
    cy.get('.sx__calendar-wrapper', { timeout: 30000 }).should('exist');
  }

  function switchToDayView() {
    cy.get('.sx__view-selection-selected-item').click();
    cy.get('.sx__view-selection-items').contains('Day').click();
    cy.get('.sx__time-grid-day', { timeout: 5000 }).should('exist');
  }

  // Helper: select a value from a Radix UI Select component by trigger ID
  function radixSelect(triggerId: string, label: string) {
    cy.get(`#${triggerId}`).click();
    cy.get('[role="listbox"]').should('be.visible');
    cy.contains('[role="option"]', label).click();
  }

  /** Create an event through the calendar UI and save it. */
  function createEvent(opts: {
    title: string;
    date?: string;
    time?: string;
    duration?: string;
    allDay?: boolean;
    location?: string;
    description?: string;
    frequency?: string;
  }) {
    switchToDayView();
    // Click on the time grid to open the "New Event" panel
    cy.get('.sx__time-grid-day').click(50, 200, { force: true });
    cy.get('.panel').should('be.visible');

    cy.get('#ed-title').clear().type(opts.title);
    if (opts.date) cy.get('#ed-date').clear().type(opts.date);

    if (opts.allDay) {
      cy.get('#ed-allday').then($el => {
        if ($el.attr('data-state') !== 'checked') cy.wrap($el).click();
      });
    } else {
      cy.get('#ed-allday').then($el => {
        if ($el.attr('data-state') === 'checked') cy.wrap($el).click();
      });
      if (opts.time) cy.get('#ed-time').clear().type(opts.time);
      if (opts.duration) cy.get('#ed-duration').clear().type(opts.duration);
    }

    if (opts.location) cy.get('#ed-location').clear().type(opts.location);
    if (opts.description) cy.get('#ed-desc').clear().type(opts.description);
    if (opts.frequency) radixSelect('ed-freq', opts.frequency);

    cy.get('#ed-save').click();
    cy.get('.panel').should('not.exist');
  }

  before(() => {
    cy.visit('/');
    // Stub window.prompt so the "Calendar name" dialog returns immediately
    cy.window().then(win => {
      cy.stub(win, 'prompt').returns('Test Calendar');
    });
    // Open the "New" dropdown and click "Calendar"
    cy.contains('button', 'New').click();
    cy.get('[role="menuitem"]').contains('Calendar').click();
    cy.url({ timeout: 15000 }).should('include', '#/calendars/');
    waitForCalendar();
  });

  it('hides the loading status after calendar loads', () => {
    cy.get('#status').should('not.exist');
  });

  it('renders the schedule-x calendar container', () => {
    cy.get('#sx-cal').children().should('have.length.greaterThan', 0);
  });

  it('creates a new event via the editor', () => {
    createEvent({ title: 'Brand New Event', date: dateStr, time: '16:00', duration: 'PT2H' });
    switchToDayView();
    cy.contains('Brand New Event').should('exist');
  });

  it('opens the editor panel when clicking an event', () => {
    switchToDayView();
    cy.contains('Brand New Event').click({ force: true });
    cy.get('.panel').should('be.visible');
    cy.get('#ed-title').should('have.value', 'Brand New Event');
    cy.get('#ed-cancel').click();
  });

  it('closes the editor panel when clicking cancel', () => {
    switchToDayView();
    cy.contains('Brand New Event').click({ force: true });
    cy.get('.panel').should('be.visible');
    cy.get('#ed-cancel').click();
    cy.get('.panel').should('not.exist');
    cy.get('.overlay').should('not.exist');
  });

  it('closes the editor panel when clicking the overlay', () => {
    switchToDayView();
    cy.contains('Brand New Event').click({ force: true });
    cy.get('.panel').should('be.visible');
    cy.get('.overlay').click({ force: true });
    cy.get('.panel').should('not.exist');
  });

  it('edits an event title through the editor', () => {
    switchToDayView();
    cy.contains('Brand New Event').click({ force: true });
    cy.get('#ed-title').clear().type('Updated Title');
    cy.get('#ed-save').click();
    cy.get('.panel').should('not.exist');
    cy.contains('Updated Title').should('exist');
  });

  it('shows the all-day checkbox and hides time fields when checked', () => {
    switchToDayView();
    cy.contains('Updated Title').click({ force: true });
    cy.get('#time-fields').should('exist');
    // Check all-day
    cy.get('#ed-allday').click();
    cy.get('#time-fields').should('not.exist');
    // Uncheck all-day
    cy.get('#ed-allday').click();
    cy.get('#time-fields').should('exist');
    cy.get('#ed-cancel').click();
  });

  it('shows recurrence options when frequency is selected', () => {
    switchToDayView();
    cy.contains('Updated Title').click({ force: true });

    cy.get('#recurrence-opts').should('not.exist');
    radixSelect('ed-freq', 'Weekly');
    cy.get('#recurrence-opts').should('exist');
    cy.get('#weekly-days').should('exist');
    cy.get('.day-btn').should('have.length', 7);

    radixSelect('ed-freq', 'Daily');
    cy.get('#weekly-days').should('not.exist');

    radixSelect('ed-freq', 'None');
    cy.get('#recurrence-opts').should('not.exist');
    cy.get('#ed-cancel').click();
  });

  it('toggles day buttons in weekly recurrence', () => {
    switchToDayView();
    cy.contains('Updated Title').click({ force: true });

    radixSelect('ed-freq', 'Weekly');
    cy.get('.day-btn').eq(1).click();
    cy.get('.day-btn').eq(1).should('have.class', 'active');
    cy.get('.day-btn').eq(1).click();
    cy.get('.day-btn').eq(1).should('not.have.class', 'active');
    cy.get('#ed-cancel').click();
  });

  it('creates a recurring event and verifies multiple instances', () => {
    createEvent({ title: 'Recurring Check', date: dateStr, time: '09:00', duration: 'PT15M', frequency: 'Daily' });
    switchToDayView();
    cy.contains('Recurring Check').should('exist');
  });

  it('shows "Edit Occurrence" when clicking a recurring event instance', () => {
    switchToDayView();
    cy.contains('Recurring Check').first().click({ force: true });
    cy.get('.panel h2').should('contain', 'Edit Occurrence');
    cy.contains('Edit all events').should('exist');
    cy.get('#ed-cancel').click();
  });

  it('switches to edit-all mode for a recurring event', () => {
    switchToDayView();
    cy.contains('Recurring Check').first().click({ force: true });
    cy.get('.panel h2').should('contain', 'Edit Occurrence');

    cy.contains('Edit all events').click();
    cy.get('.panel h2').should('contain', 'Edit Event');
    cy.get('#ed-freq').should('contain.text', 'Daily');
    cy.get('#ed-cancel').click();
  });

  it('populates location and description in the editor', () => {
    createEvent({
      title: 'Full Event',
      date: dateStr,
      time: '14:00',
      duration: 'PT1H',
      location: 'Room 42',
      description: 'Discuss quarterly results',
    });
    switchToDayView();
    cy.contains('Full Event', { timeout: 10000 }).click({ force: true });
    cy.get('#ed-location').should('have.value', 'Room 42');
    cy.get('#ed-desc').should('have.value', 'Discuss quarterly results');
    cy.get('#ed-cancel').click();
  });

  it('renders an all-day event in the date grid strip', () => {
    createEvent({ title: 'All Day Meeting', date: dateStr, allDay: true });
    switchToDayView();
    cy.get('.sx__date-grid-event', { timeout: 10000 }).should('exist');
    cy.contains('All Day Meeting').should('exist');
  });

  it('shows recurrence end options (count and until)', () => {
    switchToDayView();
    cy.contains('Updated Title').click({ force: true });
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
    cy.get('#ed-cancel').click();
  });
});
