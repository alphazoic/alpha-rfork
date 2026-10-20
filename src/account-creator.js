'use strict';

const network = require('./network-operations');

const crypto = require('crypto');

const { loadConfig }                              = require('./config');
const { getBinPath }                              = require('../binPath');
const { ensureMegaCmdServer, megaSwitch,
        megaCmdBin, megaSpawnOpts }               = require('./megacmd');
const { appendAccountRow }                        = require('./account-manager');
const { shuffleProviders }                        = require('./temp-mail');
const { signupEmailSource }                       = require('./signup-mail');
let cloudflareSignupMail;
function installCloudflareSignupMail(service) { cloudflareSignupMail = service; }

// Local cancel-error factory — callers detect cancellation via err.cancelled === true,
// NOT via instanceof.  Each engine defines its own CancelledError class; this module
// follows the same contract so its thrown cancel errors are compatible with all callers.
function makeCancelledError() {
  const err = new Error('Cancelled');
  err.cancelled = true;
  return err;
}

/**
 * Registers a brand-new MEGA account using the selected mail source and registration tool,
 * confirms it via email link, and appends a row to account_log.csv.
 *
 * PASSWORD DESIGN CHOICE: the password is generated inside this function and
 * returned to the caller.  This keeps generation co-located with the registration
 * call that needs it and avoids duplicating the generation expression in every
 * engine that calls registerMegaAccount (upload-engine.js, bulk-import-engine.js, …).
 *
 * DOES NOT create any upload/import folder or fetch any share links — that is
 * caller-specific post-registration work.  upload-engine.js does its own
 * megatools/megacmd mkdir + folder-link fetch immediately after this call returns.
 * bulk-import-engine.js does a simpler megacmd-only mkdir (no folder link needed).
 *
 * CANCELLATION CONTRACT: callers must test err.cancelled === true, NOT instanceof,
 * because each engine has its own CancelledError class in scope.
 *
 * @param {object}    opts
 * @param {string[]}  opts.createToolOrder    Tool preference, e.g. ['megatools','megacmd'].
 *                                            Falls back to config.toolOrderCreate, then
 *                                            ['megatools','megacmd'].
 * @param {Function}  opts.send               (channel, data) => void — log lines only.
 * @param {Function}  opts.shouldAbort        () => boolean — caller's kill-flag check.
 * @param {Function}  opts.trackProc          (childProcess) => void — kill-aware proc registration.
 * @param {Function}  opts.execT              (cmd, args, opts) => Promise<string> — kill-aware execRetry.
 * @param {Function}  opts.rwtT               (cmd, args, opts, ms) => Promise<string> — kill-aware runCommandWithTimeout.
 * @param {Function}  opts.cancellableDelay   (ms) => Promise<void> — cancellable delay helper.
 *
 * @returns {Promise<{ email: string, password: string, registeredWith: string }>}
 * @throws  Aggregated Error listing all tools/providers on total failure.
 * @throws  Error with .cancelled === true on cancellation.
 */
async function registerMegaAccount({ createToolOrder, send, shouldAbort, trackProc, execT, rwtT, cancellableDelay }) {
  // Password is generated here so callers do not need to pre-generate it.
  const password = crypto.randomBytes(8).toString('hex') + 'A1';

  let registeredWith = null;
  let currentEmail = '';

  const cfg = loadConfig();
  const source = signupEmailSource(cfg.signupEmailSource);
  if (source === 'cloudflare' && !cloudflareSignupMail) throw new Error('Cloudflare signup mail is not initialized. Restart M3 and try again.');
  const providers = source === 'cloudflare'
    ? await cloudflareSignupMail.providers({ shouldAbort, cancellableDelay }) : shuffleProviders();
  const createOrder = (createToolOrder && createToolOrder.length
    ? createToolOrder
    : cfg.toolOrderCreate && cfg.toolOrderCreate.length
      ? cfg.toolOrderCreate
      : ['megatools', 'megacmd']
  ).filter(t => t === 'megatools' || t === 'megacmd');

  const createErrs = {};

  for (const tool of createOrder) {
    if (registeredWith) break;
    send('up:log', `[Account Creation] Trying ${tool} registration… [${tool}]`);
    let toolErr = null;

    if (tool === 'megatools') {
      for (const provider of providers) {
        try {
          if (shouldAbort()) throw makeCancelledError();
          send('up:log', `Generating ${source === 'temp-mail' ? 'temporary ' : ''}email via ${provider.name}... [megatools]`);
          const { email: providerEmail, pollForConfirmLink } = await provider.fn();
          if (shouldAbort()) throw makeCancelledError();
          currentEmail = providerEmail;

          send('up:log', `Registering account ${currentEmail} via megatools... [megatools]`);
          const regOut = await execT(getBinPath('megatools'), [
            'reg', '--register', '--email', currentEmail, '--name', 'User', '--password', password,
          ]);
          if (shouldAbort()) throw makeCancelledError();
          const match = regOut.match(/[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=_-]+/);
          if (!match) throw new Error(
            'Could not extract verification state token.\nRaw output: ' + regOut.trim().slice(0, 300)
          );

          send('up:log', 'Waiting for confirmation email... [megatools]');
          const confirmLink = await pollForConfirmLink();
          if (shouldAbort()) throw makeCancelledError();
          if (!confirmLink) throw new Error('Confirmation email timed out.');

          await execT(getBinPath('megatools'), ['reg', '--verify', match[0], confirmLink]);
          if (shouldAbort()) throw makeCancelledError();
          registeredWith = 'megatools';
          break;

        } catch (e) {
          network.interruption(e);
          if (e.cancelled || shouldAbort()) throw e.cancelled ? e : makeCancelledError();
          send('up:log', `${provider.name} / megatools failed (${e.message}), trying next provider... [megatools]`);
          currentEmail = '';
          toolErr = e;
        }
      }

    } else if (tool === 'megacmd') {
      for (const provider of providers) {
        try {
          if (shouldAbort()) throw makeCancelledError();
          send('up:log', `Generating ${source === 'temp-mail' ? 'temporary ' : ''}email via ${provider.name}... [megacmd]`);
          const { email: providerEmail, pollForConfirmLink } = await provider.fn();
          if (shouldAbort()) throw makeCancelledError();
          currentEmail = providerEmail;

          send('up:log', `Registering account ${currentEmail} via megacmd... [megacmd]`);
          await ensureMegaCmdServer(trackProc);
          if (shouldAbort()) throw makeCancelledError();

          let loggedOut = false;
          for (let i = 0; i < 5; i++) {
            if (shouldAbort()) throw makeCancelledError();
            try { await rwtT(megaCmdBin(), ['logout'], megaSpawnOpts(), 15000); } catch { /* ignore */ }
            await cancellableDelay(1500);
            if (shouldAbort()) throw makeCancelledError();
            try {
              await rwtT(megaCmdBin(), ['whoami'], megaSpawnOpts(), 5000);
              // whoami succeeded → still logged in, loop again
            } catch {
              loggedOut = true;
              break;
            }
          }
          if (!loggedOut) throw new Error('MEGAcmd: could not log out before signup after multiple attempts.');
          if (shouldAbort()) throw makeCancelledError();

          await cancellableDelay(500);
          const signupOut = await execT(megaCmdBin(), ['signup', currentEmail, password, '--name=User Name'], megaSpawnOpts());
          send('up:log', `[signup] ${(signupOut || '').trim().slice(0, 300) || '(no output)'} [megacmd]`);
          if (shouldAbort()) throw makeCancelledError();

          send('up:log', 'Waiting for confirmation email... [megacmd]');
          const confirmLink = await pollForConfirmLink();
          if (shouldAbort()) throw makeCancelledError();
          if (!confirmLink) throw new Error('Email confirmation timeout.');

          send('up:log', 'Confirming account... [megacmd]');
          const confirmOut = await execT(megaCmdBin(), ['confirm', confirmLink, currentEmail, password], megaSpawnOpts());
          send('up:log', `[confirm] ${(confirmOut || '').trim().slice(0, 300) || '(no output)'} [megacmd]`);
          if (shouldAbort()) throw makeCancelledError();

          send('up:log', 'Logging in... [megacmd]');
          await megaSwitch(currentEmail, password, trackProc);
          if (shouldAbort()) throw makeCancelledError();
          registeredWith = 'megacmd';
          break;

        } catch (e) {
          network.interruption(e);
          if (e.cancelled || shouldAbort()) throw e.cancelled ? e : makeCancelledError();
          send('up:log', `${provider.name} / megacmd failed (${e.message}), trying next provider... [megacmd]`);
          currentEmail = '';
          toolErr = e;
        }
      }
    }

    if (!registeredWith) {
      createErrs[tool] = toolErr;
      const nextIdx = createOrder.indexOf(tool) + 1;
      if (nextIdx < createOrder.length) send('up:log', `${tool} registration failed — trying ${createOrder[nextIdx]}… [${tool}]`);
    }
  }

  if (!registeredWith) {
    throw new Error(
      `Account creation failed with all tools and providers.\n` +
      createOrder.map(t => `${t}: ${createErrs[t]?.message || 'not attempted'}`).join('\n')
    );
  }

  // Log the new account. secUpgrade reflects whether megacmd's login flow applied
  // the security upgrade (it does so automatically as part of the confirm+login sequence).
  const secUpgrade = registeredWith === 'megacmd' ? 'Yes' : 'No';
  appendAccountRow(currentEmail, password, secUpgrade);

  return { email: currentEmail, password, registeredWith };
}

module.exports = { registerMegaAccount: network.wrap('account-create', registerMegaAccount), installCloudflareSignupMail };
