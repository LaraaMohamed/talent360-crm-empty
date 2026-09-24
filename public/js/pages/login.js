import { h, mount, toast } from '../core.js';
import { api } from '../api.js';

export function loginPage(root, onSuccess) {
    document.title = 'Sign in · CRM';

    const email = h('input.input', { type: 'email', id: 'email', autocomplete: 'username', required: true, autofocus: true });
    const password = h('input.input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
    const error = h('div.error', { role: 'alert' });
    const submit = h('button.btn.primary.block', { type: 'submit' }, 'Sign in');

    const form = h('form.stack', {
        onsubmit: async (event) => {
            event.preventDefault();
            error.textContent = '';
            submit.disabled = true;
            submit.textContent = 'Signing in…';
            try {
                await api.post('/api/auth/login', {
                    email: email.value.trim(),
                    password: password.value,
                }, { allowUnauthorized: true });
                await onSuccess();
            } catch (err) {
                // Same message whichever half was wrong — the response must not
                // be usable to find out which emails exist.
                error.textContent = err.message;
                password.value = '';
                password.focus();
            } finally {
                submit.disabled = false;
                submit.textContent = 'Sign in';
            }
        },
    },
    h('div.field', h('label', { for: 'email' }, 'Email'), email),
    h('div.field', h('label', { for: 'password' }, 'Password'), password),
    error,
    submit,
    );

    mount(root, h('div.login-page',
        h('div.login-card',
            h('div.row', { style: { marginBlockEnd: 'var(--space-4)' } },
                h('span.mark', { style: {
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                } }, h('img', { src: '/logo.png', alt: 'Logo', style: { width: '28px', height: '28px', objectFit: 'contain' } })),
                h('div',
                    h('div.strong', 'Sign in'),
                    h('div.xs.dim', 'CRM'),
                ),
            ),
            form,
            h('p.xs.dim', { style: { marginBlockStart: 'var(--space-4)' } },
                'Passwords are stored as scrypt hashes and are never recoverable. '
                + 'Forgotten yours? Ask an admin for a reset link — they can issue one from '
                + 'Settings → People.'),
        ),
    ));

    return undefined;
}

/**
 * Spending a reset link.
 *
 * Reached at /reset?token=… with no session, because the whole point is that
 * the person cannot sign in. The token in the URL is the credential, so the
 * page asks for nothing but the new password.
 */
export function resetPage(root, token, onDone) {
    document.title = 'Set a new password · CRM';

    const password = h('input.input', { type: 'password', id: 'new-password', autocomplete: 'new-password', required: true, minlength: 8, autofocus: true });
    const confirm = h('input.input', { type: 'password', id: 'confirm-password', autocomplete: 'new-password', required: true });
    const error = h('div.error', { role: 'alert' });
    const submit = h('button.btn.primary.block', { type: 'submit' }, 'Set password');

    const form = h('form.stack', {
        onsubmit: async (event) => {
            event.preventDefault();
            error.textContent = '';

            // Checked here rather than server-side: a typo in the confirmation
            // is not a reason to spend a single-use link.
            if (password.value !== confirm.value) {
                error.textContent = 'Those two passwords do not match.';
                confirm.value = '';
                confirm.focus();
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Setting…';
            try {
                await api.post('/api/auth/reset', { token, password: password.value }, { allowUnauthorized: true });
                toast('Password set. Sign in with it now.', 'success');
                onDone();
            } catch (err) {
                error.textContent = err.message;
            } finally {
                submit.disabled = false;
                submit.textContent = 'Set password';
            }
        },
    },
    h('div.field', h('label', { for: 'new-password' }, 'New password'), password,
        h('span.help', 'At least 8 characters.')),
    h('div.field', h('label', { for: 'confirm-password' }, 'Confirm it'), confirm),
    error,
    submit,
    );

    mount(root, h('div.login-page',
        h('div.login-card',
            h('div.strong', { style: { marginBlockEnd: 'var(--space-4)' } }, 'Set a new password'),
            token
                ? form
                : h('div.error', 'This link is missing its token. Ask for a new one.'),
            h('p.xs.dim', { style: { marginBlockStart: 'var(--space-4)' } },
                'This link works once and expires 24 hours after it was issued. '
                + 'Setting a password signs you out of every other browser.'),
        ),
    ));

    return undefined;
}
