import { Prism } from 'prism-react-renderer';

const prismGlobal = globalThis as typeof globalThis & { Prism?: typeof Prism };
prismGlobal.Prism = Prism;

require('prismjs/components/prism-bash');
require('prismjs/components/prism-csharp');
require('prismjs/components/prism-java');
require('prismjs/components/prism-lisp');
require('prismjs/components/prism-powershell');
require('prismjs/components/prism-wasm');

export const articlePrism = Prism;
