/**
 * Route table.
 *
 * Specific routes are registered BEFORE the generic `/api/:object/...` ones,
 * because the router matches in registration order and `/api/accounts/board`
 * would otherwise be read as "the account with id `board`".
 */
import * as records from './records.mjs';
import * as accounts from './accounts.mjs';
import * as prospects from './prospects.mjs';
import * as deals from './deals.mjs';
import * as proposals from './proposals.mjs';
import * as documents from './documents.mjs';
import * as calling from './calling.mjs';
import * as views from './views.mjs';
import * as dashboard from './dashboard.mjs';
import * as search from './search.mjs';
import * as meta from './meta.mjs';
import * as qualification from './qualification.mjs';
import * as campaigns from './campaigns.mjs';
import * as imports from './imports.mjs';
import * as verification from './verification.mjs';
import * as scoring from './scoring.mjs';
import * as generation from './generation.mjs';
import * as collect from './collect.mjs';
import * as outreach from './outreach.mjs';
import * as peopleSearch from './people-search.mjs';
import * as email from './email.mjs';
import * as calendar from './calendar.mjs';
import * as meetings from './meetings.mjs';

/** Endpoints reachable without a session. Deliberately tiny. */
export const PUBLIC_ROUTES = new Set([
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'POST /api/auth/reset',
    'POST /api/setup',  // First-run setup
    'GET /api/health',  // For an external uptime monitor — see api/meta.mjs
]);

/**
 * Webhook routes — public by design, credentialled in-handler.
 *
 * Smartlead signs nothing; the secret lives in the URL. Listing them here
 * keeps server.mjs's session gate one place, and keeps isOpen a pure read on
 * exported data rather than a second import cycle.
 */
export const WEBHOOK_ROUTES = [/^POST \/api\/webhooks\/smartlead\/.+$/, /^POST \/api\/webhooks\/apollo\/.+$/];

export function registerRoutes(r) {
    /* ---- session and metadata ---- */
    r.post('/api/auth/login', meta.doLogin);
    r.post('/api/auth/logout', meta.doLogout);
    r.post('/api/auth/reset', meta.doResetPassword);
    r.post('/api/setup', meta.setup);
    r.get('/api/health', meta.health);
    r.get('/api/me', meta.me);
    r.post('/api/me/password', meta.changePassword);
    r.post('/api/users/:id/reset-link', meta.resetLink);
    r.get('/api/meta', meta.meta);
    r.patch('/api/settings', meta.updateSettings);
    r.get('/api/service-targets', meta.serviceTargets);
    r.put('/api/service-targets', meta.putServiceTarget);
    r.post('/api/users', meta.inviteUser);
    r.patch('/api/users/:id', meta.patchMember);
    r.put('/api/users/:id', meta.updateMemberProfile);
    r.post('/api/fields', meta.createField);
    r.delete('/api/fields/:id', meta.deleteField);
    r.get('/api/activity-types', meta.activityTypes);
    r.post('/api/activity-types', meta.createActivityType);
    r.get('/api/notifications', meta.notifications);
    r.post('/api/notifications/read', meta.markNotificationsRead);
    r.get('/api/api-keys', meta.listApiKeys);
    r.post('/api/api-keys', meta.createApiKey);
    r.delete('/api/api-keys/:id', meta.deleteApiKey);

    /* ---- search ---- */
    r.get('/api/search', search.search);
    r.post('/api/search/reindex', search.reindexAll);

    /* ---- views, lists, filter schema ---- */
    r.get('/api/views', views.listViews);
    r.post('/api/views', views.createView);
    r.patch('/api/views/:id', views.patchView);
    r.delete('/api/views/:id', views.deleteView);
    r.get('/api/schema', views.filterSchema);

    r.get('/api/lists', views.listLists);
    r.post('/api/lists', views.createList);
    r.patch('/api/lists/:id', views.patchList);
    r.delete('/api/lists/:id', views.deleteList);
    r.post('/api/lists/:id/members', views.listMembers);
    r.delete('/api/lists/:id/members', views.removeMembers);

/* ---- dashboards ---- */
r.get('/api/dashboards', dashboard.listDashboards);
r.get('/api/dashboards/:id/data', dashboard.dashboardData);
r.patch('/api/dashboards/:id', dashboard.patchDashboard);
// Needs-attention band: registered before :id/data would matter only if the
// paths overlapped — they don't — but it sits with its siblings regardless.
r.get('/api/dashboard/attention', dashboard.attention);

    /* ---- qualification ---- */
    r.get('/api/qualification/rules', qualification.rules);
    r.get('/api/qualification/review-queue', qualification.reviewQueue);
    r.post('/api/qualification/rules/:key/preview', qualification.preview);
    r.post('/api/qualification/rules/:key/publish', qualification.publish);
    r.post('/api/qualification/run', accounts.runQualification);
    // Upload a lead list and qualify it, in this process. Reads the shared
    // evidence tables and writes nothing, so it runs on the hosted CRM too.
    r.post('/api/qualification/list/inspect', qualification.inspectList);
    r.post('/api/qualification/list/qualify', qualification.qualifyList);
    // The collector's own page, proxied rather than reimplemented — still the
    // only way to collect a company nobody has collected. The proxy itself is
    // matched in server.mjs, ahead of this router.
    r.get('/api/qualification/uploader', qualification.uploaderStatus);
    r.post('/api/qualification/uploader/start', qualification.startUploader);
    r.post('/api/qualification/uploader/stop', qualification.stopUploader);
    // Collecting evidence for ONE company. Registered here, before the generic
    // object routes, because `:object` would otherwise swallow `collect`.
    r.get('/api/qualification/collect/:id', collect.status);

    /* ---- account specifics (before the generic object routes) ---- */
    r.post('/api/accounts/merge-preview', accounts.mergePreview);
    r.post('/api/accounts/merge', accounts.merge);
    r.post('/api/accounts/unmerge', accounts.unmerge);
    r.post('/api/accounts/:id/qualify', accounts.runOne);
    r.post('/api/accounts/:id/decision', accounts.decide);
    r.post('/api/accounts/:id/evidence', accounts.attachEvidence);
    r.get('/api/accounts/:id/verdicts', accounts.verdicts);
    r.get('/api/accounts/:id/evidence', accounts.evidence);
    r.get('/api/accounts/:id/duplicates', accounts.duplicates);

    /* ---- prospecting specifics (before the generic object routes) ---- */
    r.post('/api/prospects/import-preview', prospects.previewImport);
    r.post('/api/prospects/import', prospects.runImport);
    r.post('/api/prospects/:id/qualify', prospects.runOne);
    r.post('/api/prospects/:id/evidence', prospects.attachEvidence);
    r.get('/api/prospects/:id/verdicts', prospects.verdicts);
    r.get('/api/prospects/:id/evidence', prospects.evidence);
    /* ---- lead scoring ---- */
    r.get('/api/scoring/model', scoring.getModel);
    r.put('/api/scoring/model', scoring.putModel);
    r.post('/api/:object/score', scoring.scoreBulk);
    r.post('/api/:object/:id/score', scoring.scoreOne);
    r.get('/api/:object/:id/score', scoring.explain);

    /* ---- email verification (contacts and prospecting contacts alike) ---- */
    r.post('/api/:object/verify-emails', verification.verifyBulk);
    r.post('/api/:object/:id/verify-email', verification.verifyOne);
    r.get('/api/:object/:id/verification-history', verification.history);

    /* ---- deal specifics ---- */
    r.get('/api/deals/board', deals.board);
    r.get('/api/deals/forecast', deals.forecast);
    /**
     * Deal size: one price, one currency.
     *
     * The four line-item routes that used to be here are gone with the model
     * they served. A deal is priced, not itemised — see api/deals.mjs.
     */
    r.get('/api/deals/:id/size', deals.dealSize);
    r.put('/api/deals/:id/size', deals.putDealSize);
    // What it has been worth, and what each period ahead is worth.
    r.get('/api/deals/:id/price-history', deals.dealPriceHistory);
    r.get('/api/deals/:id/stage-history', deals.dealStageHistory);
    r.post('/api/deals/:id/price-periods/:periodId/review', deals.reviewDealPrice);
    r.post('/api/deals/:id/stage', deals.moveStage);

    /* ---- proposals and agreements ---- */
    r.post('/api/proposals', proposals.createProposal);
    r.get('/api/proposals/:id/detail', proposals.proposalDetail);
    r.post('/api/proposals/:id/versions', proposals.createVersion);
    // Draft → Pending review → Approved / Rejected, before anything is issued
    // or signed. Submitting is an edit; reviewing needs `document.approve`.
    r.post('/api/proposals/:id/submit', proposals.submitProposalForReview);
    r.post('/api/proposals/:id/review', proposals.reviewProposal);
    r.post('/api/agreements/:id/submit', proposals.submitAgreementForReview);
    r.post('/api/agreements/:id/review', proposals.reviewAgreement);
    r.post('/api/proposals/:id/versions/:version/issue', proposals.issueVersion);
    r.post('/api/proposals/:id/versions/:version/sent', proposals.markSent);
    r.post('/api/proposals/:id/sent', proposals.markProposalSent);
    r.delete('/api/proposals/:id/versions/:version', proposals.deleteVersion);
    r.get('/api/proposals/:id/versions/:version/render', proposals.renderVersion);
    r.get('/api/proposals/:id/diff', proposals.diffVersions);
    r.get('/api/agreements/renewals', proposals.renewals);
    r.post('/api/agreements/:id/sign', proposals.signAgreement);
    r.post('/api/agreements/:id/internal-proposal', proposals.retryInternalTeamProposal);
    r.post('/api/agreements/:id/renew', generation.renewAgreement);

    /* ---- import ---- */
    r.post('/api/import/profile', imports.profileFile);
    r.post('/api/import/preview', imports.preview);
    r.post('/api/import/execute', imports.execute);
    r.post('/api/import/customers/profile', imports.profileCustomersFile);
    r.post('/api/import/customers/preview', imports.previewCustomers);
    r.post('/api/import/customers/execute', imports.executeCustomers);

    r.get('/api/email-templates', email.templates);
    r.post('/api/email-templates', email.createTemplateRoute);
    r.get('/api/email-templates/:id', email.template);
    r.patch('/api/email-templates/:id', email.updateTemplateRoute);
    r.delete('/api/email-templates/:id', email.deleteTemplateRoute);
    r.post('/api/email-templates/:id/duplicate', email.duplicateTemplateRoute);
    r.post('/api/email-templates/:id/preview', email.previewTemplateRoute);
    r.post('/api/email-templates/category/:category/preview', email.previewCategoryRoute);
    r.post('/api/email/drafts', email.createDraft);
    r.get('/api/email/drafts/:id', email.draft);
    r.patch('/api/email/drafts/:id', email.updateDraftRoute);
    r.post('/api/email/drafts/:id/send', email.sendDraft);
    r.post('/api/email/drafts/:id/cancel', email.cancelDraftRoute);
    r.post('/api/email/test-send', email.testSend);

    r.get('/api/calendar', calendar.calendar);
    r.get('/api/meetings', meetings.list);
    r.get('/api/meetings/meta', meetings.meta);
    r.patch('/api/meetings/:id/settle', meetings.settle);
    r.get('/api/import/batches', imports.summaries);
    r.get('/api/import/batches/:id', imports.summary);
    r.get('/api/import/batches/:id/errors.csv', imports.errorReport);
    r.post('/api/import/batches/:id/undo', imports.undo);
    r.get('/api/import/uploads', imports.uploads);
    r.delete('/api/import/uploads/:id', imports.removeUpload);
    r.post('/api/import/uploads/:id/restore', imports.undeleteUpload);
    r.get('/api/import/templates', imports.templates);
    r.post('/api/import/templates', imports.createTemplate);
    r.delete('/api/import/templates/:id', imports.removeTemplate);

    /* ---- campaigns ---- */
    r.get('/api/campaigns/:id/members', campaigns.listMembers);
    r.post('/api/campaigns/:id/members', campaigns.addCampaignMembers);
    r.delete('/api/campaigns/:id/members', campaigns.removeCampaignMembers);
    r.patch('/api/campaigns/:id/members', campaigns.patchMemberStatus);
    r.get('/api/campaigns/:id/performance', campaigns.campaignPerformance);

    /* ---- outreach (Smartlead) ---- */
    r.post('/api/integrations/smartlead/test', outreach.testConnection);
    r.post('/api/integrations/smartlead/disconnect', outreach.disconnect);
    r.get('/api/integrations/smartlead/status', outreach.status);
    r.get('/api/integrations/smartlead/overview', outreach.campaignsOverview);
    r.get('/api/integrations/smartlead/campaigns', outreach.listSmartleadCampaigns);
    r.post('/api/integrations/smartlead/link', outreach.linkCampaign);
    r.post('/api/integrations/smartlead/unlink', outreach.unlinkCampaign);
    r.post('/api/integrations/smartlead/webhook', outreach.ensureWebhook);
    r.post('/api/integrations/smartlead/enroll', outreach.enroll);
    r.post('/api/integrations/smartlead/sync', outreach.syncNow);
    r.post('/api/integrations/smartlead/import-leads', outreach.importLeads);
    r.get('/api/integrations/smartlead/events', outreach.listEvents);
    r.post('/api/integrations/smartlead/events/:id/retry', outreach.retryOneEvent);
    r.get('/api/:object/:id/outreach', outreach.contactOutreach);
    // Public — no session. Credential is the secret in the path, verified inline.
    r.post('/api/webhooks/smartlead/:secret', outreach.webhook);
    r.post('/api/webhooks/apollo/:secret', peopleSearch.phoneWebhook);
    r.get('/api/integrations/apollo/phone-status', peopleSearch.phoneRevealStatus);

    /* ---- people discovery (provider-neutral, e.g. Apollo) ---- */
    r.get('/api/integrations/people-search/status', peopleSearch.status);
    for (const base of ['accounts', 'prospecting_companies']) {
        r.post(`/api/${base}/:id/people-search`, peopleSearch.search);
        r.post(`/api/${base}/:id/people-enrich`, peopleSearch.enrich);
        r.post(`/api/${base}/:id/people-import`, peopleSearch.importPeople);
    }
    // Sourcing's own People Search — not anchored to a company already in the
    // CRM. See generalSearch/generalImport in api/people-search.mjs.
    r.post('/api/sourcing/people-search', peopleSearch.generalSearch);
    r.post('/api/sourcing/people-enrich', peopleSearch.generalEnrich);
    r.post('/api/sourcing/people-import', peopleSearch.generalImport);
    // Reveal, gated by approval instead of `record.write.all` — the door a
    // rep uses in place of `/people-enrich` above. Account-anchored only,
    // matching `people_search.use` (lib/auth.mjs).
    r.post('/api/accounts/:id/people-enrich-request', peopleSearch.requestEnrich);
    r.get('/api/people-enrich-requests', peopleSearch.listEnrichRequests);
    r.get('/api/people-enrich-requests/:id', peopleSearch.getEnrichRequest);
    r.post('/api/people-enrich-requests/:id/review', peopleSearch.reviewEnrichRequest);

    /* ---- document generation (before the generic object routes) ---- */
    r.get('/api/deals/:id/document-options', generation.dealDocumentOptions);
    r.post('/api/deals/:id/documents/check', generation.checkGeneration);
    r.post('/api/deals/:id/documents', generation.generateForDeal);
    r.get('/api/deals/:id/documents', generation.dealDocumentHistory);
    r.get('/api/deals/:id/services', generation.getServices);
    r.put('/api/deals/:id/services', generation.putServices);
    // The account is the primary way in: a proposal is written for a company,
    // and requiring a deal first is what made this unreachable.
    r.get('/api/accounts/:id/document-options', generation.accountDocumentOptions);
    r.post('/api/accounts/:id/documents/preview', generation.previewForAccount);
    r.post('/api/accounts/:id/documents', generation.generateForAccount);
    // Above /api/accounts/:id/documents, or "links" is read as a document id.
    r.get('/api/accounts/:id/documents/links', documents.accountDocumentLinks);
    r.get('/api/accounts/:id/documents', generation.accountDocumentHistory);
    // A version edited outside the CRM: `?type=`, `?mode=new_version|replace_current`.
    r.post('/api/accounts/:id/document-versions', generation.uploadDocumentVersion);
    r.get('/api/accounts/:id/services', generation.getAccountServices);
    r.put('/api/accounts/:id/services', generation.putAccountServices);
    r.get('/api/accounts/:id/commercial-registration', generation.getRegistration);
    r.put('/api/accounts/:id/commercial-registration', generation.putRegistration);
    r.get('/api/document-templates', generation.listTemplates);
    r.post('/api/document-templates', generation.uploadTemplate);

    /* ---- documents ---- */
    r.post('/api/documents/upload', documents.upload);
    r.get('/api/documents/:id/link', documents.link);
    r.get('/api/documents/:id/download', documents.download);

    /* ---- cold calling ----
     *
     * Registered BEFORE the generic record routes, so /api/calling/... is never
     * read as an object named "calling". Every handler scopes its own reads: an
     * SDR reaching any of these sees only work assigned to them.
     */
    r.get('/api/calling/meta', calling.meta);
    r.get('/api/calling/today', calling.today);
    r.get('/api/calling/queue', calling.listQueue);
    r.get('/api/calling/queue/ids', calling.queueIds);
    r.get('/api/calling/counts', calling.counts);
    r.post('/api/calling/assign', calling.assign);
    r.post('/api/calling/contacts', calling.createContact);
    r.post('/api/calling/remove', calling.remove);
    r.patch('/api/calling/priority', calling.prioritise);
    r.patch('/api/calling/status', calling.setStatus);
    r.patch('/api/calling/services', calling.setServices);
    r.post('/api/calling/log-bulk', calling.logBulkOutcome);
    // Whether THIS contact currently has a live queue row, and whose —
    // what the Contact record page's Add/Remove/Open-in-Cold-Calling button
    // needs before it can decide which of the three to show.
    r.get('/api/calling/contacts/:id/status', calling.contactStatus);
    // A rep/SDR asking that a contact go to somebody else — see
    // requestReassign/reviewReassignRequest in api/calling.mjs for why this
    // is a request rather than the assign endpoint above.
    r.post('/api/calling/contacts/:id/reassign-request', calling.requestReassign);
    r.get('/api/calling/reassign-requests', calling.listReassignRequests);
    r.post('/api/calling/reassign-requests/:id/review', calling.reviewReassignRequest);
    r.get('/api/calling/assignments/:id', calling.readAssignment);
    // Edits the LEAD behind this assignment (name/phone/email/services) —
    // see calling.editContact for why it is a separate door from the
    // generic /api/contacts/:id an SDR cannot reach.
    r.patch('/api/calling/assignments/:id/contact', calling.editContact);
    r.get('/api/calling/assignments/:id/history', calling.history);
    r.post('/api/calling/assignments/:id/call', calling.call);
    r.post('/api/calling/assignments/:id/message', calling.message);
    /**
     * Moving a follow-up, which is not the same request as logging a call.
     *
     * "They asked me to ring Thursday instead" adds no call and changes no
     * outcome — it moves a date, and the four steps hanging off it. Sending it
     * through `call` would append a second identical call to the history every
     * time somebody corrected a typo.
     */
    r.patch('/api/calling/assignments/:id/follow-up', calling.reschedule);
    // Admin-only — see clearCallingActivity in lib/calling.mjs.
    r.post('/api/calling/assignments/:id/clear-activity', calling.clearActivity);

    /* ---- generic record routes, last ---- */
    r.get('/api/:object/export.csv', records.exportCsv);
    r.get('/api/:object/view-counts', records.viewCounts);
    r.get('/api/:object/field-values', records.fieldValues);
    r.post('/api/:object/bulk', records.bulk);
    r.post('/api/:object/batch-delete', records.batchDelete);
    r.get('/api/:object', records.list);
    r.post('/api/:object', records.create);
    r.get('/api/:object/:id', records.read);
    r.patch('/api/:object/:id', records.patch);
    r.delete('/api/:object/:id', records.remove);
    r.post('/api/:object/:id/restore', records.restore);
    r.delete('/api/:object/:id/purge', records.purge);
    // Only accounts and prospecting companies answer these; the handler says so
    // rather than the route table having to list them twice.
    r.get('/api/:object/:id/collectability', collect.collectability);
    r.post('/api/:object/:id/collect', collect.start);
    r.get('/api/:object/:id/related', records.related);
    // Page two onward of one related list, driven by the same spec as page one.
    r.get('/api/:object/:id/related/:child', records.relatedPage);
    r.get('/api/:object/:id/campaigns', campaigns.membershipFor);
    r.get('/api/:object/:id/timeline', accounts.timeline);
    r.get('/api/:object/:id/audit', records.history);
}

/**
 * The download endpoint accepts a signed URL instead of a session, so it is
 * checked separately in server.mjs rather than being listed as fully public —
 * the signature IS the authorisation, and it is verified inside the handler.
 */
export const SIGNED_ROUTES = [/^GET \/api\/documents\/[^/]+\/download$/];
