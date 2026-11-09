/**
 * Setup: what this machine needs before a first agent can start, and the choices worth making
 * first, in one window: omp installed, a model provider signed in (omp's own `omp login`, run by
 * the daemon and shown here as it goes: daemon/setup.js), which browser agents drive, GitHub's
 * CLI for pull request windows, the phone (optional: Phone access over Tailscale, offered once
 * Tailscale runs here) and the daemon's switches. An empty screen opens it until the checks
 * first pass (the daemon's `setupDone`); the palette opens it any time.
 */
import { button, el, setText } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { DAEMON_SETTINGS, browserChoice, phoneAccess, switchRow } from '../ui/settings.js';
import { getDaemon } from '../daemon/client.js';
/** @import { SetupCheck, SetupStatus } from '../../daemon/setup.js' */
/** @import { WidgetContext } from './registry.js' */

/**
 * One step: a heading with how it stands, what it is for, and what to do while it is missing.
 * @param {string} title @param {string} about
 */
function step(title, about) {
  const root = el('section', 'setup-step');
  const state = el('span', 'setup-state');
  const head = el('h3', 'setup-step-title', title);
  head.append(' ', state);
  const todo = el('div', 'setup-todo');
  root.append(head, el('p', 'setup-about', about), todo);
  return {
    root,
    todo,
    /** @param {SetupCheck | null} check null while it is being checked */
    show(check) {
      root.dataset.state = check ? (check.ok ? 'ok' : 'missing') : 'checking';
      setText(state, check ? `${check.ok ? '✓' : '✗'} ${check.detail}` : 'Checking…');
      todo.hidden = check?.ok !== false;
    },
  };
}

/** A command to run in a terminal, as it is typed. @param {string} command */
const shell = (command) => el('code', 'setup-command', command);

/** @param {...(string | Node)} parts */
function para(...parts) {
  const p = el('p');
  p.append(...parts);
  return p;
}

export default {
  type: 'setup',
  title: 'Setup',
  glyph: '✓',
  description: 'What Cockpit needs on this machine (omp, a model sign-in, GitHub) and which browser agents use',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    const daemon = getDaemon();
    const root = el('div', 'setup');
    root.append(el('p', 'setup-lead', 'A few things before your first agent. Each step is checked here; Check again after fixing one in a terminal.'));

    const omp = step('1. omp', 'The coding agent every Agent window runs. Cockpit runs the omp on your PATH (or the one --omp names).');
    omp.todo.append(para('Install it, then Check again: ', shell('curl -fsSL https://omp.sh/install | sh')));

    const models = step('2. A model provider', 'Agents need a model to talk to. omp signs in to subscriptions (Claude Pro/Max, ChatGPT, GitHub Copilot…) in your browser.');
    const loginOutput = el('pre', 'setup-login-output');
    const loginStatus = el('p', 'setup-login-status');
    const answer = el('input', 'setup-login-input');
    answer.placeholder = 'Type here, Enter sends it to omp login';
    answer.setAttribute('aria-label', 'Answer omp login');
    const answerForm = el('form', 'setup-login-form');
    const cancel = button('btn', 'Cancel', () => void daemon.cancelLogin().catch(() => {}));
    answerForm.append(answer, cancel);
    const login = el('div', 'setup-login');
    login.append(loginStatus, loginOutput, answerForm);
    const signIn = button('btn btn-accent', 'Sign in…', () => {
      signIn.disabled = true;
      daemon.startLogin().catch((err) => {
        signIn.disabled = false;
        setText(loginStatus, errorMessage(err));
      });
    });
    models.todo.append(
      para(signIn, ' runs omp login: pick a provider by number below, then finish in the browser tab it opens.'),
      login,
      para('Or set an API key (', shell('ANTHROPIC_API_KEY'), ', ', shell('OPENAI_API_KEY'), '…) in the shell that runs ', shell('bun start'), ', and restart it.'),
    );
    answerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const line = answer.value;
      answer.value = '';
      daemon.answerLogin(line).catch((err) => setText(loginStatus, errorMessage(err)));
    });

    const browser = el('section', 'setup-step');
    browser.append(el('h3', 'setup-step-title', '3. Agents’ browser'));

    const gh = step('4. GitHub (optional)', 'Pull request windows read and comment through GitHub’s CLI, signed in as you. Everything else works without it.');
    gh.todo.append(para('Install it from ', shell('https://cli.github.com'), ', then run ', shell('gh auth login'), ' in a terminal.'));

    const phoneStep = step(
      '5. Your phone (optional)',
      'Read and answer your agents from an Android phone, over Tailscale, while this Mac is awake and Cockpit runs. Only devices signed in to Tailscale as you get in. Everything else works without it.',
    );
    phoneStep.todo.append(para('Install Tailscale on this Mac from ', shell('https://tailscale.com/download'), ', sign in and connect, then Check again.'));
    const phoneReady = el('div', 'setup-phone');
    phoneReady.hidden = true;
    phoneReady.append(
      para(
        'On the phone, install the Tailscale app and sign in with the same account. In Android’s VPN settings, turn on Always-on VPN and Block connections without VPN for Tailscale: the phone’s page is plain HTTP, safe only inside the tunnel. Then turn Phone access on and scan the QR code with the phone’s camera.',
      ),
    );
    phoneStep.root.append(phoneReady);

    const prefs = el('section', 'setup-step');
    prefs.append(
      el('h3', 'setup-step-title', '6. Preferences'),
      el('p', 'setup-about', 'Kept by the daemon, for every browser; Config in the top bar changes them later. Notify, also in the top bar, adds desktop notifications when an agent finishes or needs you.'),
    );
    const prefsList = el('div', 'setup-prefs');
    prefs.append(prefsList);

    const recheck = button('btn', 'Check again', () => void check());
    const start = button('btn btn-accent', 'Start an agent', () => ctx.openBeside('omp', {}));
    const actions = el('div', 'setup-actions');
    actions.append(recheck, start);
    root.append(omp.root, models.root, browser, gh.root, phoneStep.root, prefs, actions);
    body.append(root);

    /** Phone access, once the daemon's settings are known. @type {ReturnType<typeof phoneAccess> | null} */
    let phone = null;
    /** Whether Tailscale runs here, as last checked. */
    let tailscaleOk = false;
    /** Phone access is offered once Tailscale runs here, or while it is on (to switch it off). */
    function drawPhone() {
      phoneReady.hidden = !(tailscaleOk || daemon.settings()?.remote === true);
      phone?.show();
    }

    /** @type {ReturnType<typeof browserChoice> | null} */
    let choice = null;
    /** @type {Map<string, HTMLInputElement>} */
    const boxes = new Map();
    function drawSettings() {
      const settings = daemon.settings();
      if (!settings) return;
      if (!choice) {
        choice = browserChoice(daemon, settings.browser);
        browser.append(choice.root);
        phone = phoneAccess(daemon);
        phoneReady.append(phone.root);
        drawPhone();
        prefsList.append(
          ...DAEMON_SETTINGS.map((setting) => {
            const { row, box } = switchRow(setting.label, setting.detail, settings[setting.key], (on) => {
              daemon.changeSettings({ [setting.key]: on }).catch(() => (box.checked = !on));
            });
            boxes.set(setting.key, box);
            return row;
          }),
        );
        return;
      }
      choice.show(settings.browser);
      drawPhone();
      for (const setting of DAEMON_SETTINGS) {
        const box = boxes.get(setting.key);
        if (box) box.checked = settings[setting.key];
      }
    }

    let checking = 0;
    async function check() {
      const run = ++checking;
      recheck.disabled = true;
      start.disabled = true;
      for (const s of [omp, models, gh, phoneStep]) s.show(null);
      /** @type {SetupStatus} */
      let status;
      try {
        status = await daemon.setup();
      } catch (err) {
        if (run !== checking) return;
        recheck.disabled = false;
        const failed = { ok: false, detail: `Could not check: ${errorMessage(err)}` };
        for (const s of [omp, models, gh, phoneStep]) s.show(failed);
        return;
      }
      if (run !== checking) return;
      recheck.disabled = false;
      omp.show(status.omp);
      models.show(status.models);
      gh.show(status.gh);
      phoneStep.show(status.tailscale);
      tailscaleOk = status.tailscale.ok;
      drawPhone();
      const ready = status.omp.ok && status.models.ok;
      start.disabled = !ready;
      // Ready once: an empty screen no longer opens Setup.
      if (ready && daemon.settings()?.setupDone === false) daemon.changeSettings({ setupDone: true }).catch(() => {});
    }

    let wasRunning = daemon.login()?.running ?? false;
    function drawLogin() {
      const state = daemon.login();
      login.hidden = !state;
      const running = state?.running ?? false;
      signIn.disabled = running;
      answer.disabled = !running;
      cancel.hidden = !running;
      if (state) {
        const atEnd = loginOutput.scrollTop + loginOutput.clientHeight >= loginOutput.scrollHeight - 4;
        setText(loginOutput, state.output);
        if (atEnd) loginOutput.scrollTop = loginOutput.scrollHeight;
        setText(
          loginStatus,
          running ? 'omp login is running' : state.exitCode === 0 ? 'omp login finished' : `omp login ended (exit ${state.exitCode ?? '?'})`,
        );
      }
      // A login that just ended may have signed in: see.
      if (wasRunning && !running) void check();
      wasRunning = running;
    }

    const offSettings = daemon.onSettings(drawSettings);
    const offLogin = daemon.onLogin(drawLogin);
    const offRemote = daemon.onRemote(drawPhone);
    drawSettings();
    drawLogin();
    void check();
    return {
      destroy() {
        checking++;
        offSettings();
        offLogin();
        offRemote();
      },
    };
  },
};
