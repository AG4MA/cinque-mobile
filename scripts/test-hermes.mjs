import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// Run with HERMES_BIN pointing to a Hermes VM executable, not hermesc.
// No engine binaries are shipped with the app. All generated test files stay in work/.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.HERMES_TEST_OUTPUT || path.join(project, 'work', 'hermes-regression'));
const bin = process.env.HERMES_BIN;
if (!bin || !path.isAbsolute(bin) || !fs.existsSync(bin)) {
  throw new Error('Set HERMES_BIN to an absolute path to a runnable Hermes VM (hermes.exe / hermes), not hermesc.');
}
fs.mkdirSync(output, { recursive: true });
const read = file => fs.readFileSync(path.join(project, file), 'utf8');
const result = { timestamp: new Date().toISOString(), binary: bin, version: '', reproduction: null, fixed: null };
const version = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15_000 });
result.version = (version.stdout || '') + (version.stderr || '');

function run(name, source) {
  const filename = path.join(output, `${name}.js`);
  fs.writeFileSync(filename, source);
  const run = spawnSync(bin, ['-O0', filename], { encoding: 'utf8', timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
  const stdout = run.stdout || '';
  const stderr = run.stderr || '';
  fs.writeFileSync(path.join(output, `${name}.log`), stdout + stderr);
  const line = stdout.split(/\r?\n/).find(line => line.startsWith('HERMES_RESULT '));
  return { status: run.status, signal: run.signal, error: run.error?.message, ...(line ? JSON.parse(line.slice(14)) : {}), log: path.join(output, `${name}.log`) };
}

// This reproduces the original Metro JSON-as-object-literal path. A runtime with
// the Hermes large-array bug exposes a hole at index 65535 and Map throws.
const originalContext = read('assets/context/it-context.json');
result.reproduction = run('original-literal', `var dataset=${originalContext};
var failure = -1;
for (var i=0;i<dataset.contexts.length;i++) {
  if (!Array.isArray(dataset.contexts[i])) { failure=i; break; }
}
var message=null, size=null;
try { size=new Map(dataset.contexts).size; } catch(e) { message=e.message; }
print('HERMES_RESULT '+JSON.stringify({firstInvalidRow:failure,errorMessage:message,mapSize:size}));
`);

const modules = [
  ['lexicon', read('assets/runtime/lexicon.js')],
  ['context', read('assets/runtime/context.js')],
  ['openings', read('assets/runtime/openings.js')],
  ['probability', read('assets/runtime/probability.js')],
  ['calibration', 'module.exports=JSON.parse(' + JSON.stringify(read('src/prediction/calibration.json')) + ');'],
  ['lexical-engine', ts.transpileModule(read('src/prediction/lexical-engine.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText],
  ['opening-policy', ts.transpileModule(read('src/prediction/opening-policy.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText],
  ['statistical-engine', ts.transpileModule(read('src/prediction/statistical-engine.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText],
  ['probability-index', ts.transpileModule(read('src/prediction/probability-index.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText],
  ['probabilistic-engine', ts.transpileModule(read('src/prediction/probabilistic-engine.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText],
  ['keyboard-cost', ts.transpileModule(read('src/prediction/keyboard-cost.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText],
  ['adaptive-letters', ts.transpileModule(read('src/prediction/adaptive-letters.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText],
  ['letter-pages', ts.transpileModule(read('src/prediction/letter-pages.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText],
];
const expectedLexicon = JSON.parse(read('assets/lexicon/it.json')).entries.length;
const expectedContext = JSON.parse(originalContext).contexts.length;
const expectedOpenings = JSON.parse(read('assets/context/it-openings.json')).entries.length;
const probabilityData = JSON.parse(read('assets/probability/it-model.json'));
const expectedProbabilityContexts = probabilityData.contexts.length;
const expectedUnigram = probabilityData.unigram.length;
const expectedContinuation = probabilityData.continuation.length;
const setup = `var factories={}, cache={};
function require(name) {
  if (name.slice(0,2)==='./') name=name.slice(2);
  if (cache[name]) return cache[name].exports;
  var module={exports:{}}; cache[name]=module;
  factories[name](module,module.exports,require); return module.exports;
}
` + modules.map(([name, code]) => `factories[${JSON.stringify(name)}]=function(module,exports,require){\n${code}\n};`).join('\n');
result.fixed = run('fixed-full-engine', setup + `
var checks=0;
function assert(ok, message) { checks++; if(!ok) throw new Error(message); }
function close(a,b,message) { assert(Math.abs(a-b)<1e-8,message+': '+a+' / '+b); }
var lexicon=require('lexicon'), context=require('context'), openings=require('openings');
assert(lexicon.entries.length===${expectedLexicon},'lexicon length');
assert(context.contexts.length===${expectedContext},'context length');
assert(openings.entries.length===${expectedOpenings},'openings length');
for(var i=0;i<lexicon.entries.length;i++) {
  var row=lexicon.entries[i];
  assert(Array.isArray(row)&&typeof row[0]==='string'&&typeof row[1]==='number','lexicon row '+i);
}
for(var i=0;i<context.contexts.length;i++) {
  var row=context.contexts[i];
  assert(Array.isArray(row)&&typeof row[0]==='string'&&Array.isArray(row[1]),'context row '+i);
  for(var j=0;j<row[1].length;j++) assert(Array.isArray(row[1][j])&&typeof row[1][j][0]==='string'&&typeof row[1][j][1]==='number','transition '+i+':'+j);
}
var openingWords=new Set();
for(var i=0;i<openings.entries.length;i++) {
  var row=openings.entries[i];
  assert(Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&Number.isSafeInteger(row[1])&&row[1]>0,'opening row '+i);
  openingWords.add(row[0]);
}
assert(openingWords.size===openings.entries.length,'opening words unique');
var model=require('probability'), calibration=require('calibration');
assert(model.contexts.length===${expectedProbabilityContexts},'probability context length');
assert(model.unigram.length===${expectedUnigram},'unigram length');
assert(model.continuation.length===${expectedContinuation},'continuation length');
var currentOpeningCount=0;
for(var i=0;i<model.contexts.length;i++) {
  var row=model.contexts[i];
  assert(Array.isArray(row)&&row.length===4&&typeof row[0]==='string'&&Number.isSafeInteger(row[1])&&row[1]>0&&Number.isSafeInteger(row[2])&&row[2]>0&&Array.isArray(row[3]),'probability context row '+i);
  var retained=0;
  for(var j=0;j<row[3].length;j++) {
    var pair=row[3][j];
    assert(Array.isArray(pair)&&pair.length===2&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1])&&pair[1]>0,'probability transition '+i+':'+j);
    retained+=pair[1];
  }
  assert(retained<=row[1]&&row[3].length<=row[2],'full denominator preserves pruned mass '+i);
  if(row[0]==='<s>') currentOpeningCount=row[3].length;
}
for(var fieldIndex=0;fieldIndex<2;fieldIndex++) {
  var field=['unigram','continuation'][fieldIndex];
  for(var i=0;i<model[field].length;i++) {
    var pair=model[field][i];
    assert(Array.isArray(pair)&&pair.length===2&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1])&&pair[1]>0,field+' row '+i);
  }
}
assert(currentOpeningCount>10000,'complete current opening counts');
assert(model.metadata.statistics.trainingSequences===817943,'training excludes dev and test');
assert(model.metadata.statistics.developmentSequences===45415,'dev split');
assert(model.metadata.statistics.testSequences===45160,'test split');
var LexicalEngine=require('lexical-engine').LexicalEngine;
var lexical=new LexicalEngine(lexicon.entries);
var ProbabilisticEngine=require('probabilistic-engine').ProbabilisticEngine;
var stats=new ProbabilisticEngine(lexicon.entries,model,calibration.options);
assert(stats.contextCount===${expectedProbabilityContexts},'Map preserved every probability context');
assert(stats.lexical.count===${expectedLexicon}&&stats.contextOrder===3,'production engine metadata');
assert(lexical.frequency('caffè')>0,'accented frequency');
var samples=['','Vorrei bere ac','La tastiera italiana è molt','Perché l’acq','Ho finito. ','Va bene? ','Bene!'+String.fromCharCode(10),'Ho finito. ca'];
var predictions=[];
for(var i=0;i<samples.length;i++) {
  var prediction=stats.predict(samples[i]);
  assert(prediction.letters.length===33,'full 33-letter support for '+samples[i]);
  assert(new Set(prediction.letters.map(function(item){return item.letter;})).size===33,'unique support');
  assert(prediction.words.length>0,'completions for '+samples[i]);
  var prefix=require('lexical-engine').splitComposition(samples[i]).prefix;
  for(var j=0;j<prediction.words.length;j++) {
    var word=prediction.words[j];
    assert(typeof word.word==='string'&&word.word.startsWith(prefix),'completion respects prefix');
    assert(Number.isFinite(word.score)&&word.score>0&&word.score<=1.0000001,'conditional word probability');
    assert(word.word.length>1||['a','e','è','i','o'].indexOf(word.word)>=0,'valid standalone word');
  }
  if(i===0||i>=4) assert(prediction.source==='opening','opening policy at sentence start');
  var letterSum=0;
  for(var j=0;j<prediction.letters.length;j++) {
    assert(Number.isFinite(prediction.letters[j].score)&&prediction.letters[j].score>0,'positive finite letter probability');
    letterSum+=prediction.letters[j].score;
  }
  close(letterSum,1,'normalized conditional next letter');
  assert(Number.isFinite(prediction.entropy)&&prediction.entropy>=0&&prediction.entropy<=Math.log2(33),'finite bounded entropy');
  assert(Number.isFinite(prediction.endProbability)&&prediction.endProbability>=0&&prediction.endProbability<=1,'end probability');
  predictions.push({input:samples[i],source:prediction.source,words:prediction.words.map(function(w){return w.word;})});
}
assert(stats.predict('zelmocrino è un nome. zelmocr').words.some(function(w){return w.word==='zelmocrino';}),'session learns name');
assert(!stats.predict('zelmocr').words.some(function(w){return w.word==='zelmocrino';}),'undo forgets name');
assert(stats.predict('zxq').letters.length>=4,'fallback alphabet');
assert(stats.predict('ci').words.some(function(w){return w.word==='ciao';}),'conversational ciao');
assert(stats.predict('bu').words.some(function(w){return w.word==='buongiorno';}),'conversational buongiorno');
assert(stats.predict('vorrei bere un ca').words[0].word==='caffè','phrase context coffee');
var originalName=JSON.stringify(stats.predict('zelmocr'));
var learnedName=JSON.stringify(stats.predict('zelmocrino è un nome. zelmocr'));
assert(JSON.stringify(stats.predict('zelmocrino è un nome. zelmocr'))===learnedName,'prediction calls do not accumulate learning');
assert(JSON.stringify(stats.predict('zelmocr'))===originalName,'undo exactly restores prediction');
var adaptive=require('adaptive-letters');
var adaptiveSamples=['','m','vo','p','Ho finito. ','Ho finito. ca'];
var adaptiveResults=[];
var previousSlots=[];
function checkStable(previous, selected, capacity) {
  var previousBefore=JSON.stringify(previous), selectedBefore=JSON.stringify(selected);
  var slots=adaptive.placeStableLetters(previous,selected,capacity);
  assert(slots.length===capacity,'stable slots capacity');
  var letters=slots.filter(Boolean).map(function(item){return item.letter;});
  assert(new Set(letters).size===letters.length,'stable slots unique');
  assert(selected.every(function(item){return letters.indexOf(item.letter)>=0;}),'all selected letters reachable');
  assert(JSON.stringify(previous)===previousBefore&&JSON.stringify(selected)===selectedBefore,'assignment preserves inputs');
  assert(JSON.stringify(adaptive.placeStableLetters(slots,selected,capacity))===JSON.stringify(slots),'assignment stays stable without new evidence');
  return slots;
}
for(var i=0;i<adaptiveSamples.length;i++) {
  var sample=adaptiveSamples[i];
  var selected=adaptive.chooseAdaptiveLetters(stats.predict(sample).letters);
  assert(selected.letters.length===selected.count,'adaptive length matches count');
  assert(selected.count>=4&&selected.count<=10,'adaptive count bounds');
  assert(Number.isFinite(selected.coverage)&&selected.coverage>0&&selected.coverage<=1.0000001,'adaptive finite coverage');
  assert(Number.isFinite(selected.expectedTimeMs)&&selected.expectedTimeMs>0,'finite modeled cost');
  assert(Number.isFinite(selected.entropyBits)&&selected.entropyBits>=0,'finite decision entropy');
  previousSlots=checkStable(previousSlots,selected.letters,selected.count);
  assert(selected.count<=adaptive.DEFAULT_MAX_LETTERS,'default adaptive cap');
  adaptiveResults.push({input:sample,count:selected.count,letters:selected.letters.map(function(item){return item.letter;}),coverage:selected.coverage});
}
assert(new Set(adaptiveResults.map(function(item){return item.count;})).size>1,'real predictions adapt keyboard size');
var flat='abcdefghijklmnopqrstuvwxyz'.split('').map(function(letter){return {letter:letter,score:1};});
var cost=require('keyboard-cost');
for(var cap=4;cap<=10;cap++) {
  var selected=adaptive.chooseAdaptiveLetters(flat,cap);
  assert(selected.count>=4&&selected.count<=cap,'adaptive cap '+cap);
  var rankedFlat=adaptive.rankLetterCandidates(flat), geometry=cost.keyboardGeometry(cap);
  for(var count=4;count<=cap;count++) assert(selected.expectedTimeMs<=cost.estimateKeyboardCost(rankedFlat,count,geometry).expectedTimeMs+0.01,'chosen count minimizes modeled cost');
}
assert(adaptive.chooseAdaptiveLetters(flat,-5).count===4,'adaptive lower cap clamp');
assert(adaptive.chooseAdaptiveLetters(flat,99).count<=10,'adaptive upper cap clamp');
assert(adaptive.chooseAdaptiveLetters(flat,NaN).count<=8,'adaptive invalid cap fallback');
assert(adaptive.chooseAdaptiveLetters([],10).count>=4,'adaptive empty input fallback');
function candidates(letters) { return letters.split('').map(function(letter){return {letter:letter,score:1};}); }
var shrunk=checkStable(candidates('abcdef'),candidates('ebcg'),4);
assert(shrunk.every(function(item){return item!==null;}),'stable shrink fills slots');
var grown=checkStable(shrunk,candidates('hcbega'),6);
assert(grown.every(function(item){return item!==null;}),'stable grow fills slots');
var pagination=require('letter-pages');
var pageSamples=adaptiveSamples.concat(['zxq','caff','Perché l’acq']);
var pageResults=[];
for(var sampleIndex=0;sampleIndex<pageSamples.length;sampleIndex++) {
  var sample=pageSamples[sampleIndex];
  var immutable=Object.freeze(stats.predict(sample).letters.map(function(item){return Object.freeze({letter:item.letter,score:item.score});}));
  var before=JSON.stringify(immutable);
  var ranked=adaptive.rankLetterCandidates(immutable);
  for(var cap=4;cap<=10;cap++) {
    var pages=pagination.buildLetterPages(immutable,cap);
    var first=adaptive.chooseAdaptiveLetters(immutable,cap).letters;
    assert(JSON.stringify(pages[0])===JSON.stringify(first),'first page matches adaptive selection');
    var seen=new Set(), visible=[];
    for(var pageIndex=0;pageIndex<pages.length;pageIndex++) {
      var page=pages[pageIndex];
      assert(page.length>=4&&page.length<=cap,'page has four to cap usable targets');
      assert(new Set(page.map(function(item){return item.letter;})).size===page.length,'page letters unique');
      checkStable([],page,cap);
      for(var itemIndex=0;itemIndex<page.length;itemIndex++) {
        var item=page[itemIndex];
        assert(Number.isFinite(item.score)&&item.score>=0,'page weights finite');
        if(itemIndex>0) assert(page[itemIndex-1].score>=item.score,'page follows descending rank');
        if(!seen.has(item.letter)) { seen.add(item.letter); visible.push(item.letter); }
      }
    }
    assert(ranked.every(function(item){return seen.has(item.letter);}), 'all positive ranked letters reachable');
    assert(seen.size===33,'all 33 letters reachable through ranked pages');
    var rankedWords=ranked.map(function(item){return item.letter;});
    assert(JSON.stringify(visible.filter(function(letter){return rankedWords.indexOf(letter)>=0;}))===JSON.stringify(rankedWords),'new choices follow global rank across pages');
    assert(JSON.stringify(immutable)===before,'pagination preserves input selection and weights');
    if(cap===adaptive.DEFAULT_MAX_LETTERS) pageResults.push({input:sample,pageSizes:pages.map(function(page){return page.length;}),rankedLetters:rankedWords.join('')});
    pages[0][0].score=123;
    pages[0].reverse();
    assert(JSON.stringify(immutable)===before,'changing returned page cannot mutate candidates');
    assert(JSON.stringify(pagination.buildLetterPages(immutable,cap)[0])===JSON.stringify(first),'later pagination remains independent');
  }
}
var spellings=['ciao','buongiorno','zaffiro','caffè','xyz','vorrei bere un caffè'];
var caps=[4,6,8,10];
for(var capIndex=0;capIndex<caps.length;capIndex++) {
  var cap=caps[capIndex];
  for(var spellingIndex=0;spellingIndex<spellings.length;spellingIndex++) {
    var target=spellings[spellingIndex], composition='';
    for(var letterIndex=0;letterIndex<target.length;letterIndex++) {
      var letter=target[letterIndex];
      if(letter===' ') { composition+=' '; continue; }
      var pages=pagination.buildLetterPages(stats.predict(composition).letters,cap);
      var found=pages.some(function(page){return page.some(function(item){return item.letter===letter;});});
      assert(found,'spelling reachable at cap '+cap+' letter '+letter);
      composition+=letter;
      var next=stats.predict(composition), reset=pagination.buildLetterPages(next.letters,cap);
      assert(JSON.stringify(reset[0])===JSON.stringify(adaptive.chooseAdaptiveLetters(next.letters,cap).letters),'typing resets to best next page');
    }
    assert(composition===target,'complete spelling');
  }
}
print('HERMES_RESULT '+JSON.stringify({passed:true,checks:checks,lexiconCount:stats.lexical.count,contextCount:stats.contextCount,openingCount:currentOpeningCount,calibration:calibration.options,predictions:predictions,adaptive:adaptiveResults,pagination:pageResults}));
`);
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.fixed.passed || result.fixed.status !== 0) process.exitCode = 1;
