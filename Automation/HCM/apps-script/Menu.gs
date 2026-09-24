/**
 * Menu.gs
 *
 * Wires up the "Proposal Generator" custom menu. Kept intentionally tiny —
 * this file should only ever grow by one addItem() line per new menu action.
 */

/**
 * Runs automatically when the spreadsheet is opened.
 * @param {GoogleAppsScript.Events.SheetsOnOpen} e
 */
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('Proposal Generator')
    .addItem('New Proposal', 'createNewProposalRow')
    .addItem('Generate Proposal', 'generateProposal')
    .addSeparator()
    .addItem('Open Generated Proposal', 'openGeneratedProposal')
    .addToUi();
}
