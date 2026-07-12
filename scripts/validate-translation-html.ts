import { applyTranslationPlan, createTranslationBatches, createTranslationPlan, hashText, isStoredTranslationValid, parseStoredTranslation, removeImagesFromHtml, splitTopLevelHtml, validateTranslationBlocks } from '../src/utils/translationHtml';
const assert=(value:unknown,message='assertion failed'):asserts value=>{if(!value)throw new Error(message);};
assert.equal=(actual:unknown,expected:unknown)=>assert(actual===expected,`${String(actual)} !== ${String(expected)}`);
assert.throws=(run:()=>unknown)=>{let threw=false;try{run();}catch{threw=true;}assert(threw,'expected function to throw');};

const source='<h2 style="color:red" class="x">Hello</h2><p id="p" onclick="bad()">Run <code>pnpm install</code>, read <strong>important</strong> <a href="https://example.com">docs</a>.</p><ul><li>One<ul><li><p>Two</p></li></ul></li></ul><blockquote><p>Quote</p></blockquote><table><tr><th colspan="2">Head</th></tr><tr><td rowspan="2">Cell</td></tr></table><img src="https://example.com/a.png" alt="A" onerror="bad()"><pre>const x = 1;</pre>';
const plan=createTranslationPlan(source);
assert(plan.blocks.some(x=>x.markup.includes('<x0>important</x0>')));
assert(plan.blocks.some(x=>x.markup.includes('⟦p0⟧')));
assert.equal(plan.blocks.filter(x=>x.markup.includes('Two')).length,1);
const legacyPlan=createTranslationPlan(`<table><tr><td>${Array.from({length:140},(_,i)=>`Line ${i}<br>`).join('')}</td></tr></table>`);
assert.equal((legacyPlan.blocks[0].markup.match(/⟦p\d+⟧/g)??[]).length,0);
assert.equal((legacyPlan.blocks[0].markup.match(/\n/g)??[]).length,140);
assert(applyTranslationPlan(legacyPlan,legacyPlan.blocks.map(x=>[x.id,x.markup.replace('Line','行')] as [string,string])).includes('<br>'));
const brokenArticle=`<font face=serif><center><span style=color:#999>February 2020</span><br><br>_____</center><div><span>What should an essay be? Many people would say <strong>persuasive</strong>.</span><br><br><span>To start with, that means it should be correct <a href=#fn1>1</a>.</span><br><br><img src=cover.jpg><br>________</div>${Array.from({length:30},(_,i)=>`<a href=#note-${i}></a>`).join('')}</font>`;
const brokenPlan=createTranslationPlan(brokenArticle);
assert.equal(brokenPlan.blocks.length,2);
assert(brokenPlan.blocks[0].markup.startsWith('What should an essay be?'));
assert(brokenPlan.blocks[1].markup.startsWith('To start with'));
assert(!brokenPlan.blocks.some(x=>/<x\d+>February 2020/.test(x.markup)));
assert(!brokenPlan.blocks.some(x=>x.markup.includes('⟦p')));
assert(!brokenPlan.blocks.some(x=>/_{3,}/.test(x.markup)));
assert(!brokenPlan.blocks.some(x=>/<x\d+>.*(?:What should|To start)[\s\S]*(?:What should|To start)/.test(x.markup)));
assert(brokenPlan.sourceHtml.includes('data-translation-id'));
assert.throws(()=>validateTranslationBlocks([{id:'bad-protected',markup:`Text ${Array.from({length:13},(_,i)=>`⟦p${i}⟧`).join('')}`}]))
assert.throws(()=>validateTranslationBlocks([{id:'bad-inline',markup:`Text ${Array.from({length:13},(_,i)=>`<x${i}>a</x${i}>`).join('')}`}]))
assert.throws(()=>validateTranslationBlocks([{id:'bad-size',markup:'a'.repeat(12001)}]))
assert.throws(()=>createTranslationBatches([{id:'bad-before-request',markup:'a'.repeat(12001)}]))
const results=plan.blocks.map(({id,markup})=>[id,markup.replace('Hello','你好').replace('Run ','请先运行 ').replace('important','重要').replace('docs','文档').replace('One','一').replace('Two','二').replace('Quote','引用').replace('Head','表头').replace('Cell','单元格')] as [string,string]);
const html=applyTranslationPlan(plan,results);
for(const forbidden of ['style=','class=','onclick=','onerror=','color:'])assert(!html.includes(forbidden));
for(const expected of ['<h2>你好</h2>','<code>pnpm install</code>','href="https://example.com"','colspan="2"','rowspan="2"','src="https://example.com/a.png"','<pre>const x = 1;</pre>'])assert(html.includes(expected),expected);
assert.equal(splitTopLevelHtml(html).filter(x=>x.startsWith('<ul')).length,1);
assert(!removeImagesFromHtml(html).includes('<img'));
assert.throws(()=>applyTranslationPlan(plan,results.slice(1)));
assert.throws(()=>applyTranslationPlan(plan,[...results,results[0]]));
const marked=plan.blocks.findIndex(x=>x.markup.includes('<x0>'));if(marked>=0){const bad=[...results];bad[marked]=[bad[marked][0],bad[marked][1].replace(/<x0>|<\/x0>/g,'')];assert.throws(()=>applyTranslationPlan(plan,bad));}
const stored={v:2 as const,title:'标题',sourceHash:plan.sourceHash,promptHash:hashText('prompt'),blocks:results};
assert(parseStoredTranslation(JSON.stringify(stored)));assert(!parseStoredTranslation('{bad'));assert(isStoredTranslationValid(stored,{sourceHash:plan.sourceHash,promptHash:hashText('prompt')}));assert(!isStoredTranslationValid(stored,{sourceHash:'changed',promptHash:stored.promptHash}));
console.log(`translationHtml validation passed (${plan.blocks.length} blocks)`);
