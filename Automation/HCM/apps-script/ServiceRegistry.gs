/**
 * ServiceRegistry.gs
 *
 * Domain model for Section 3 ("Scope of Work") of the proposal.
 *
 * The template represents each service as a heading paragraph that contains
 * two control tokens baked in at authoring time:
 *   {{SEC:<KEY>}}   - an invisible marker used only to locate the block and
 *                      its boundaries. Removed from the text once processed.
 *   {{NUM:<KEY>}}   - replaced with the service's assigned "3.N" number.
 *
 * Example heading in the template:
 *   {{SEC:RECRUITMENT}}{{NUM:RECRUITMENT}} Recruitment & Selection – ({{EMPLOYEES_TO_HIRE}} Positions During The Contract)
 *
 * A "block" is everything from that heading paragraph up to (but not
 * including) the next paragraph that either starts a new service block or
 * begins Section 4. No separate start/end marker pair is needed — the
 * heading IS the marker, which keeps the template itself simple to edit.
 *
 * THIS ARRAY DEFINES THE ORDER SERVICES APPEAR IN THE PROPOSAL AND THE ORDER
 * THEY ARE RENUMBERED. To add a new service in the future:
 *   1. Add a checkbox column to the sheet (Config.gs COLUMNS + SHEET_HEADERS).
 *   2. Add its heading block to the Google Doc template using the same
 *      {{SEC:KEY}}{{NUM:KEY}} pattern, followed by whatever content belongs
 *      to that service (paragraphs, tables, etc.).
 *   3. Add one entry to SERVICE_REGISTRY below, in the position you want it
 *      to appear.
 * TemplateEngine.gs and ProposalGenerator.gs require no changes.
 */
var SERVICE_REGISTRY = [
  {
    key: 'RECRUITMENT',
    column: COLUMNS.RECRUITMENT,
    scopeLabel: 'Recruitment & Selection',
    secToken: '{{SEC:RECRUITMENT}}',
    numToken: '{{NUM:RECRUITMENT}}'
  },
  {
    key: 'ONBOARDING',
    column: COLUMNS.ONBOARDING,
    scopeLabel: 'Employee Onboarding',
    secToken: '{{SEC:ONBOARDING}}',
    numToken: '{{NUM:ONBOARDING}}'
  },
  {
    key: 'BENEFITS',
    column: COLUMNS.BENEFITS,
    scopeLabel: 'Benefits Administration',
    secToken: '{{SEC:BENEFITS}}',
    numToken: '{{NUM:BENEFITS}}'
  },
  {
    key: 'PERFORMANCE',
    column: COLUMNS.PERFORMANCE,
    scopeLabel: 'Performance Management',
    secToken: '{{SEC:PERFORMANCE}}',
    numToken: '{{NUM:PERFORMANCE}}'
  },
  {
    key: 'RELATIONS',
    column: COLUMNS.RELATIONS,
    scopeLabel: 'Employee Relations',
    secToken: '{{SEC:RELATIONS}}',
    numToken: '{{NUM:RELATIONS}}'
  },
  {
    key: 'COMPENSATION',
    column: COLUMNS.COMPENSATION,
    scopeLabel: 'Compensation Administration',
    secToken: '{{SEC:COMPENSATION}}',
    numToken: '{{NUM:COMPENSATION}}'
  },
  {
    key: 'PERSONNEL',
    column: COLUMNS.PERSONNEL,
    scopeLabel: 'Personnel Administration',
    secToken: '{{SEC:PERSONNEL}}',
    numToken: '{{NUM:PERSONNEL}}'
  }
];

/** Spelled-out counting words, used for the "engagement covers {{SERVICE_COUNT_WORD}}
 *  integrated HR operational functions" sentence so it never goes stale either. */
var COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * Returns the services checked TRUE on the given row, in canonical
 * SERVICE_REGISTRY order (this order is what guarantees 3.1, 3.2, 3.3... is
 * always assigned consistently regardless of which services are unchecked).
 * @param {Object} rowObj Row data keyed by COLUMNS.* names (see Helpers.getRowObject_).
 * @return {Array<Object>} the enabled entries from SERVICE_REGISTRY.
 */
function getEnabledServices_(rowObj) {
  return SERVICE_REGISTRY.filter(function (svc) {
    return rowObj[svc.column] === true;
  });
}
