/**
 * Menu.gs
 *
 * Wires up the "Proposal Generator" custom menu.
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
