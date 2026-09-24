/**
 * Menu.gs
 *
 * Wires up the "Talent 360 DMS" custom menu. Kept intentionally tiny —
 * this file should only ever grow by one addItem() line per new action.
 */

/**
 * Runs automatically when the spreadsheet is opened.
 * @param {GoogleAppsScript.Events.SheetsOnOpen} e
 */
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('Talent 360 DMS')
    .addItem('New Opportunity', 'showNewOpportunityDialog_')
    .addItem('Generate Document', 'showGenerateDocumentWizard_')
    .addItem('View Document History', 'showHistorySidebar_')
    .addSeparator()
    .addItem('Settings', 'showSettingsDialog_')
    .addSeparator()
    .addItem('Initialize / Repair Sheets', 'setupSpreadsheet_')
    .addToUi();
}
