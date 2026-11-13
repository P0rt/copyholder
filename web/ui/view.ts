// DOM for the page's screens: consent, instruction, recording, messages. No framework (spec 7.3).
import type { BarMotion } from '../scenarios/format.ts';
import type { Instruction } from '../scenarios/instructions.ts';
import { grantConsent, type Consent, type ConsentText } from './consent.ts';
import { deviceRowsForPanel, panelText, type DevicePanelRow } from './device-panel.ts';
import type { HelloSettings } from './messages.ts';
import type { RunView } from './run.ts';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: { class?: string; id?: string; type?: string; hidden?: boolean; text?: string; attrs?: Record<string, string> } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.type) el.setAttribute('type', props.type);
  if (props.hidden) el.hidden = true;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

export interface RunScreen extends RunView {
  onWaitButton(fn: () => void): void;
  onLevel(fn: (db: number) => void): void;
  devices(settings: HelloSettings): void;
}

export interface PageView {
  message(title: string, text: string, kind?: 'info' | 'error'): void;
  /** Resolves the consent token on 'I agree, start' (minted in its click handler), null on Cancel. */
  consent(text: ConsentText, onAgreeClick: () => void): Promise<Consent | null>;
  instruction(ins: Instruction, ready: Promise<unknown>): Promise<void>;
  run(opts: { meters: boolean; devicePanel: boolean; levelsDb: readonly number[] }): RunScreen;
  /**
   * host's quickcheck line in large type: GOOD RECORDING or RE-RECORD NOW: <reason> (spec 9.3). It
   * takes the prompt's place while the run screen is up, else it goes under the current message
   * (after Stop or an abort the run screen is gone, and the verdict still comes).
   */
  verdict(ok: boolean | null, text: string): void;
  recording(on: boolean): void;
  onStop(fn: () => void): void;
  dotVisible(on: boolean): void;
}

function markVerdict(el: HTMLElement, ok: boolean | null, text: string): void {
  el.textContent = text;
  el.classList.toggle('verdict-ok', ok === true);
  el.classList.toggle('verdict-bad', ok === false);
}

export function createPageView(doc: Document): PageView {
  const screen = doc.getElementById('screen') ?? doc.body.appendChild(h(doc, 'main', { id: 'screen', class: 'screen' }));
  const dot = doc.getElementById('dot') ?? doc.body.appendChild(h(doc, 'div', { id: 'dot', class: 'dot', hidden: true }));
  const rec = doc.getElementById('rec');
  const stop = doc.getElementById('stop');
  let stopFn: (() => void) | null = null;
  stop?.addEventListener('click', () => stopFn?.());
  /** The run screen's prompt and note while that screen is shown. */
  let runText: { prompt: HTMLElement; note: HTMLElement } | null = null;

  const set = (...nodes: Node[]) => screen.replaceChildren(...nodes);

  return {
    message(title, text, kind = 'info') {
      set(h(doc, 'section', { class: `message ${kind}` }, [h(doc, 'h1', { text: title }), h(doc, 'p', { text })]));
    },

    verdict(ok, text) {
      if (runText?.prompt.isConnected) {
        markVerdict(runText.prompt, ok, text);
        runText.note.textContent = '';
        return;
      }
      const host = screen.firstElementChild ?? screen;
      let line = host.querySelector<HTMLElement>('#verdict');
      if (!line) {
        line = h(doc, 'p', { id: 'verdict', class: 'verdict' });
        host.append(line);
      }
      markVerdict(line, ok, text);
    },

    consent(text, onAgreeClick) {
      const bullets = h(
        doc,
        'ul',
        { class: 'consent-list' },
        text.bullets.map((runs) => h(doc, 'li', {}, runs.map((r) => (r.code ? h(doc, 'code', { text: r.text }) : r.text)))),
      );
      const agree = h(doc, 'button', { type: 'button', class: 'primary', id: 'agree', text: text.agree });
      const cancel = h(doc, 'button', { type: 'button', id: 'cancel', text: text.cancel });
      const box = h(doc, 'section', { class: 'consent', attrs: { 'aria-labelledby': 'consent-title' } }, [
        h(doc, 'h1', { id: 'consent-title', text: text.title }),
        h(doc, 'p', { text: text.lead }),
        bullets,
        text.after ? h(doc, 'p', { class: 'after', text: text.after }) : null,
        h(doc, 'div', { class: 'actions' }, [agree, cancel]),
      ]);
      set(box);
      agree.focus();
      return new Promise<Consent | null>((resolve) => {
        agree.addEventListener('click', () => {
          agree.disabled = true;
          cancel.disabled = true;
          const token = grantConsent(new Date().toISOString());
          onAgreeClick();
          resolve(token);
        });
        cancel.addEventListener('click', () => {
          agree.disabled = true;
          cancel.disabled = true;
          resolve(null);
        });
      });
    },

    instruction(ins, ready) {
      const blocks = ins.blocks.map((b) => {
        if (b.kind === 'p') return h(doc, 'p', { text: b.text });
        if (b.kind === 'ol') return h(doc, 'div', { class: 'steps' }, b.items.map((item, i) => h(doc, 'p', { text: `${i + 1}. ${item}` })));
        return h(doc, 'p', { class: 'lines' }, b.lines.flatMap((line, i) => (i === 0 ? [line] : [h(doc, 'br'), line])));
      });
      const start = h(doc, 'button', { type: 'button', class: 'primary', id: 'start', text: ins.button });
      const wait = h(doc, 'p', { class: 'note', id: 'instruction-note', text: 'Loading the narrator...' });
      start.disabled = true;
      set(
        h(doc, 'section', { class: 'instruction' }, [
          ...blocks,
          h(doc, 'div', { class: 'actions' }, [ins.footer ? h(doc, 'span', { class: 'footer', text: ins.footer }) : null, start]),
          wait,
        ]),
      );
      return new Promise<void>((resolve, reject) => {
        ready.then(
          () => {
            wait.textContent = '';
            start.disabled = false;
            start.focus();
          },
          (err: unknown) => {
            wait.textContent = err instanceof Error ? err.message : String(err);
            wait.classList.add('error');
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
        start.addEventListener('click', () => {
          start.disabled = true;
          resolve();
        });
      });
    },

    run(opts) {
      const prompt = h(doc, 'p', { class: 'prompt', id: 'prompt' });
      const fill = h(doc, 'div', { class: 'bar-fill' });
      const bar = h(doc, 'div', { class: 'bar', id: 'bar', hidden: true }, [fill]);
      const note = h(doc, 'p', { class: 'note', id: 'note' });
      const goButton = h(doc, 'button', { type: 'button', class: 'primary', id: 'go', hidden: true });
      const levelButtons = opts.levelsDb.map((db, i) =>
        h(doc, 'button', { type: 'button', class: 'level', text: String(i + 1), attrs: { 'data-db': String(db), 'aria-label': `Level ${i + 1}, ${db} dB` } }),
      );
      const levels = h(doc, 'div', { class: 'levels', id: 'levels', hidden: true }, [
        h(doc, 'span', { class: 'levels-end', text: 'Quieter' }),
        ...levelButtons,
        h(doc, 'span', { class: 'levels-end', text: 'Louder' }),
      ]);
      const status = h(doc, 'p', { class: 'status', id: 'status', hidden: true });
      const micMeter = h(doc, 'div', { class: 'meter-fill' });
      const outMeter = h(doc, 'div', { class: 'meter-fill' });
      const meters = h(doc, 'div', { class: 'meters', id: 'meters', hidden: !opts.meters }, [
        h(doc, 'span', { text: 'Microphone' }),
        h(doc, 'div', { class: 'meter' }, [micMeter]),
        h(doc, 'span', { text: 'Narrator' }),
        h(doc, 'div', { class: 'meter' }, [outMeter]),
      ]);
      const devicesBox = h(doc, 'dl', { class: 'devices', id: 'devices', hidden: true });
      set(h(doc, 'section', { class: 'run' }, [prompt, bar, note, goButton, levels, devicesBox, meters, status]));
      runText = { prompt, note };
      dot.hidden = false;

      let waitFn: (() => void) | null = null;
      let levelFn: ((db: number) => void) | null = null;
      goButton.addEventListener('click', () => waitFn?.());
      for (const b of levelButtons) b.addEventListener('click', () => levelFn?.(Number(b.dataset.db)));
      const meterWidth = (db: number) => `${Math.max(0, Math.min(100, ((db + 90) / 90) * 100)).toFixed(1)}%`;

      const view: RunScreen = {
        prompt(text) {
          prompt.textContent = text;
        },
        bar(motion: BarMotion | null, seconds: number) {
          if (!motion) {
            bar.hidden = true;
            fill.style.transition = 'none';
            return;
          }
          bar.hidden = false;
          const from = motion === 'grow' ? 0 : 1;
          fill.style.transition = 'none';
          fill.style.transform = `scaleX(${from})`;
          void fill.offsetWidth; // start the transition from `from`
          fill.style.transition = `transform ${seconds}s linear`;
          fill.style.transform = `scaleX(${1 - from})`;
        },
        dot(on) {
          dot.classList.toggle('on', on);
        },
        note(text) {
          note.textContent = text;
        },
        waitButton(label) {
          goButton.hidden = label === null;
          goButton.textContent = label ?? '';
          if (label !== null) goButton.focus();
        },
        levels(visible, selectedDb) {
          levels.hidden = !visible;
          for (const b of levelButtons) b.classList.toggle('selected', Number(b.dataset.db) === selectedDb);
        },
        status(text) {
          status.hidden = text === null;
          status.textContent = text ?? '';
        },
        meters(ch0Db, ch1Db) {
          if (meters.hidden) return;
          micMeter.style.width = meterWidth(ch0Db);
          outMeter.style.width = meterWidth(ch1Db);
        },
        recording(on) {
          if (rec) rec.hidden = !on;
        },
        onWaitButton(fn) {
          waitFn = fn;
        },
        onLevel(fn) {
          levelFn = fn;
        },
        devices(settings) {
          if (!opts.devicePanel) return;
          devicesBox.hidden = false;
          devicesBox.replaceChildren(...deviceRowsForPanel(settings).flatMap((r: DevicePanelRow) => [
            h(doc, 'dt', { text: r.label }),
            h(doc, 'dd', { class: r.state, text: panelText(r) }),
          ]));
        },
      };
      return view;
    },

    recording(on) {
      if (rec) rec.hidden = !on;
    },

    onStop(fn) {
      stopFn = fn;
    },

    dotVisible(on) {
      dot.hidden = !on;
      if (!on) dot.classList.remove('on');
    },
  };
}
