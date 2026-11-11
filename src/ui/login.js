/**
 * Signing omp in to a model provider, or another account, without a conversation: `omp login`,
 * run by the daemon (daemon/setup.js) and shown as it goes, its questions answered from a line
 * here. The daemon runs one login at a time, so every page showing it shows the same one. The
 * Setup window and Config's Accounts each show one.
 */
import { button, el, setText } from './dom.js';
import { errorMessage } from './format.js';
/** @import { DaemonClient } from '../daemon/client.js' */

/**
 * The Sign in button that starts a login, and the panel that shows it: its output, how it
 * stands, and a line to answer it with (or Cancel).
 * @param {DaemonClient} daemon
 * @param {{ onEnded?: () => void }} [options] `onEnded`: a login just ended, which may have signed in
 */
export function createLogin(daemon, { onEnded = () => {} } = {}) {
  const output = el('pre', 'login-output');
  const status = el('p', 'login-status');
  const answer = el('input', 'login-input');
  answer.placeholder = 'Type here, Enter sends it to omp login';
  answer.setAttribute('aria-label', 'Answer omp login');
  const form = el('form', 'login-form');
  const cancel = button('btn', 'Cancel', () => void daemon.cancelLogin().catch(() => {}));
  form.append(answer, cancel);
  const panel = el('div', 'login');
  panel.append(status, output, form);
  const signIn = button('btn btn-accent', 'Sign in…', () => {
    signIn.disabled = true;
    daemon.startLogin().catch((err) => {
      signIn.disabled = false;
      setText(status, errorMessage(err));
    });
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const line = answer.value;
    answer.value = '';
    daemon.answerLogin(line).catch((err) => setText(status, errorMessage(err)));
  });

  let wasRunning = daemon.login()?.running ?? false;
  function draw() {
    const state = daemon.login();
    panel.hidden = !state;
    const running = state?.running ?? false;
    signIn.disabled = running;
    answer.disabled = !running;
    cancel.hidden = !running;
    if (state) {
      const atEnd = output.scrollTop + output.clientHeight >= output.scrollHeight - 4;
      setText(output, state.output);
      if (atEnd) output.scrollTop = output.scrollHeight;
      setText(status, running ? 'omp login is running' : state.exitCode === 0 ? 'omp login finished' : `omp login ended (exit ${state.exitCode ?? '?'})`);
    }
    if (wasRunning && !running) onEnded();
    wasRunning = running;
  }
  const off = daemon.onLogin(draw);
  draw();
  return { signIn, panel, destroy: off };
}
