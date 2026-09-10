import type { Extension } from '@codemirror/state';

/**
 * Loads a CodeMirror language pack for a path, lazily.
 *
 * Every import here is dynamic, for the same reason `highlighter.ts` loads Shiki
 * dynamically: a room that never opens a Python file should not pay for the
 * Python grammar. Static imports would pull every grammar into the main bundle,
 * and CodeMirror's small footprint over Monaco — one of the reasons it was
 * chosen — is only real if the grammars stay out of the critical path.
 *
 * An unknown extension returns null rather than a default grammar. Highlighting
 * a `.conf` file as JavaScript is worse than not highlighting it: wrong colour
 * is read as meaning, absent colour is read as absent support.
 */
export async function loadLanguage(path: string): Promise<Extension | null> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();

  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case 'js':
    case 'mjs':
    case 'cjs':
      return (await import('@codemirror/lang-javascript')).javascript();
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'md':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'py':
      return (await import('@codemirror/lang-python')).python();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'html':
    case 'htm':
      return (await import('@codemirror/lang-html')).html();
    default:
      return null;
  }
}
