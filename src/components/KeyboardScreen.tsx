import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { placeStableLetters } from '../prediction/adaptive-letters';
import { buildLetterPages } from '../prediction/letter-pages';
import { keyboardGeometry, type KeyboardGeometry } from '../prediction/keyboard-cost';
import { reportDiagnostic } from '../diagnostics';

export type LetterSuggestion = { letter: string; score: number };
export type WordSuggestion = { word: string; score: number };
export type KeyboardScreenProps = {
  text: string;
  onTextChange: (text: string) => void;
  prediction: {
    letters: LetterSuggestion[];
    words: WordSuggestion[];
    source: 'lexicon' | 'context' | 'opening';
    busy: boolean;
  };
  onCopy: () => Promise<void>;
  lexiconCount: number;
  contextCount: number;
  contextOrder: number;
};

const LIGHT = {
  background: '#F3F5F0',
  surface: '#FFFFFF',
  surfaceSubtle: '#E9EEE6',
  ink: '#172A23',
  muted: '#65736B',
  border: '#DCE4D9',
  accent: '#235C43',
  accentInk: '#FFFFFF',
  accentSoft: '#DEEDDF',
  error: '#9D3D32',
  shadow: '#183525',
};
const DARK: typeof LIGHT = {
  background: '#111A16',
  surface: '#1B2821',
  surfaceSubtle: '#25352B',
  ink: '#EEF4EA',
  muted: '#A9B8AA',
  border: '#34483A',
  accent: '#B6E3AF',
  accentInk: '#153320',
  accentSoft: '#2E4933',
  error: '#FFABA0',
  shadow: '#000000',
};

const ALPHABET = [
  ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  ['h', 'i', 'j', 'k', 'l', 'm', 'n'],
  ['o', 'p', 'q', 'r', 's', 't', 'u'],
  ['v', 'w', 'x', 'y', 'z', "'", '-'],
  ['à', 'è', 'é', 'ì', 'ò', 'ù', 'ç'],
];
const NUMBERS = [
  ['1', '2', '3', '4', '5'],
  ['6', '7', '8', '9', '0'],
  ['.', ',', '!', '?', ':'],
  [';', '/', '-', '+', '='],
];
const SYMBOLS = [
  ['@', '#', '€', '%', '&'],
  ['(', ')', '[', ']', '*'],
  ['"', "'", '«', '»', '_'],
  ['\\', '|', '<', '>', '~'],
  ['$', '£', '^', '{', '}'],
];

export default function KeyboardScreen({
  text,
  onTextChange,
  prediction,
  onCopy,
  lexiconCount,
  contextCount,
  contextOrder,
}: KeyboardScreenProps) {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? DARK : LIGHT;
  const { width, height } = useWindowDimensions();
  const compact = height < 860;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alphabetOpen, setAlphabetOpen] = useState(false);
  const [alphabetTab, setAlphabetTab] = useState<'abc' | '123' | 'simboli'>('abc');
  const [shift, setShift] = useState<boolean | null>(null);
  const [leftHand, setLeftHand] = useState(false);
  const [maxLetters, setMaxLetters] = useState(8);
  const [letterPage, setLetterPage] = useState({ text, maxLetters: 8, index: 0 });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [historySize, setHistorySize] = useState(0);
  const history = useRef<string[]>([]);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useRef<ScrollView>(null);
  const previousLayout = useRef<{ key: string; slots: Array<LetterSuggestion | null> }>({ key: '', slots: [] });
  const geometry = useMemo<KeyboardGeometry>(() => keyboardGeometry(maxLetters, {
    width: Math.min(width, 620) - (width < 360 ? 28 : 40), leftHand,
  }), [maxLetters, width, leftHand]);
  const firstPageKey = `${maxLetters}:${leftHand}:0`;
  const letterPages = useMemo(() => buildLetterPages(prediction.letters, maxLetters, {
    geometry, previous: previousLayout.current.key === firstPageKey ? previousLayout.current.slots : [],
  }), [prediction.letters, maxLetters, geometry, firstPageKey]);
  const pageIndex = letterPage.text === text && letterPage.maxLetters === maxLetters
    ? Math.min(letterPage.index, letterPages.length - 1) : 0;
  const visibleLetters = letterPages[pageIndex];
  const pageKey = `${maxLetters}:${leftHand}:${pageIndex}`;
  const slots = useMemo(() => placeStableLetters(
    previousLayout.current.key === pageKey ? previousLayout.current.slots : [], visibleLetters,
    maxLetters, { geometry },
  ), [visibleLetters, maxLetters, geometry, pageKey]);
  useLayoutEffect(() => { previousLayout.current = { key: pageKey, slots }; }, [pageKey, slots]);
  const gridColumns = maxLetters === 4 ? 2 : 4;
  const gridRows = Math.ceil(maxLetters / gridColumns);
  const bestLetter = visibleLetters[0]?.letter;
  const lastLetterPage = pageIndex === letterPages.length - 1;
  const currentWord = text.match(/[a-zàèéìòù]+$/iu)?.[0] ?? '';
  const automaticCapital = text.length === 0 || /(?:[.!?]\s+|\n\s*)$/u.test(text);
  const capital = shift ?? automaticCapital;
  const grid = alphabetTab === 'abc' ? ALPHABET : alphabetTab === '123' ? NUMBERS : SYMBOLS;
  const words = prediction.words.slice(0, 3);
  useEffect(() => {
    reportDiagnostic('choices', { letterCount: visibleLetters.length, maxLetters, pageIndex, pageCount: letterPages.length });
  }, [visibleLetters.length, maxLetters, pageIndex, letterPages.length]);

  useEffect(() => {
    setLetterPage(current => current.text === text && current.maxLetters === maxLetters
      ? current : { text, maxLetters, index: 0 });
  }, [text, maxLetters]);

  useEffect(() => () => {
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
  }, []);

  function commit(value: string) {
    if (value === text) return;
    history.current.push(text);
    if (history.current.length > 100) history.current.shift();
    setHistorySize(history.current.length);
    setCopied(false);
    setCopyError(false);
    setLetterPage({ text: value, maxLetters, index: 0 });
    onTextChange(value);
  }

  function insert(value: string) {
    const insertion = capital && /^[a-zà-öø-ÿ]$/iu.test(value) ? value.toLocaleUpperCase('it') : value;
    commit(text + insertion);
    if (shift !== null) setShift(null);
  }

  function removeLast() {
    commit(Array.from(text).slice(0, -1).join(''));
  }

  function undo() {
    const previous = history.current.pop();
    if (previous === undefined) return;
    setHistorySize(history.current.length);
    setCopied(false);
    setCopyError(false);
    setLetterPage({ text: previous, maxLetters, index: 0 });
    onTextChange(previous);
  }

  function complete(word: string) {
    let result = word;
    if (currentWord.length > 1 && currentWord === currentWord.toLocaleUpperCase('it')) {
      result = word.toLocaleUpperCase('it');
    } else if (capital || /^[A-ZÀ-ÖØ-Þ]/u.test(currentWord)) {
      result = word.charAt(0).toLocaleUpperCase('it') + word.slice(1);
    }
    commit(text.slice(0, text.length - currentWord.length) + result + ' ');
    setShift(null);
  }

  async function copy() {
    setCopyError(false);
    try {
      await onCopy();
      setCopied(true);
      AccessibilityInfo.announceForAccessibility('Testo copiato');
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setCopyError(true);
      AccessibilityInfo.announceForAccessibility('Copia non riuscita. Riprova.');
    }
  }

  function openSource(url: string) {
    void Linking.openURL(url).catch(() => Alert.alert('Link non disponibile', 'Non è stato possibile aprire questa pagina.'));
  }

  function clearText() {
    if (text) commit('');
  }

  const subtleButton = { backgroundColor: colors.surfaceSubtle, borderColor: colors.border };
  const textStyle = { color: colors.ink };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.background} />
      <ScrollView style={styles.mainScroll} contentContainerStyle={[styles.screen, { paddingHorizontal: width < 360 ? 14 : 20 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.brandMark, { backgroundColor: colors.accent }]}>
              <View style={styles.dotRow}>{[0, 1, 2].map((n) => <View key={n} style={[styles.dot, { backgroundColor: colors.accentInk }]} />)}</View>
              <View style={styles.dotRow}>{[0, 1].map((n) => <View key={n} style={[styles.dot, { backgroundColor: colors.accentInk }]} />)}</View>
            </View>
            <Text accessibilityRole="header" style={[styles.brandName, textStyle]}>cinque</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Apri impostazioni e previsioni statistiche" onPress={() => setSettingsOpen(true)} style={({ pressed }) => [styles.settingsButton, subtleButton, pressed && styles.pressed]}>
            <Text style={[styles.settingsText, textStyle]}>Impostazioni</Text>
          </Pressable>
        </View>

        {!compact && <Text style={[styles.tagline, { color: colors.muted }]}>Una mano. Le tue parole.</Text>}

        <Pressable accessibilityRole="button" accessibilityLabel="Previsioni statistiche offline. Apri impostazioni." onPress={() => setSettingsOpen(true)} style={[styles.statusRow, compact && { marginBottom: 10 }]}>
          <View style={[styles.statusDot, { backgroundColor: colors.accent }]} />
          <Text style={[styles.statusText, { color: colors.muted }]}>Previsioni statistiche</Text>
          <Text style={[styles.privateBadge, { color: colors.accent }]}>100% offline</Text>
        </Pressable>

        <View style={[styles.editorCard, { backgroundColor: colors.surface, borderColor: colors.border, minHeight: compact ? 106 : 155 }]}>
          <View style={styles.editorTop}>
            <Text style={[styles.eyebrow, { color: colors.muted }]}>IL TUO TESTO</Text>
            <Pressable disabled={!text} accessibilityRole="button" accessibilityLabel="Copia tutto il testo" onPress={copy} hitSlop={8} style={[styles.copyButton, { opacity: text ? 1 : 0.4 }]}>
              <Text style={[styles.copyText, { color: colors.accent }]}>{copied ? 'Copiato ✓' : 'Copia'}</Text>
            </Pressable>
          </View>
          <ScrollView ref={editor} style={styles.editorScroll} contentContainerStyle={styles.editorContent} onContentSizeChange={() => editor.current?.scrollToEnd({ animated: false })}>
            {text ? (
              <Text selectable accessibilityLabel={`Testo scritto: ${text}`} style={[styles.composition, textStyle, compact && { fontSize: 23 }]}>{text}<Text accessibilityElementsHidden style={{ color: colors.accent }}>│</Text></Text>
            ) : (
              <Text style={[styles.composition, { color: colors.muted }, compact && { fontSize: 23 }]}>Comincia da una lettera<Text style={{ color: colors.accent }}>│</Text></Text>
            )}
          </ScrollView>
          <View style={styles.editorBottom}>
            <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: copyError ? colors.error : colors.muted }]}>{copyError ? 'Copia non riuscita. Riprova.' : `${Array.from(text).length.toLocaleString('it-IT')} caratteri`}</Text>
            {!!text && <Pressable onPress={clearText} hitSlop={8} accessibilityRole="button" accessibilityLabel="Svuota tutto il testo. Puoi recuperarlo con Annulla."><Text style={[styles.caption, { color: colors.muted }]}>Svuota</Text></Pressable>}
          </View>
        </View>

        <View style={[styles.keyboard, compact && { paddingTop: 14 }]}>
          <View style={styles.suggestionHeading}>
            <Text style={[styles.eyebrow, { color: colors.muted }]}>COMPLETA CON UN TOCCO</Text>
            {prediction.busy ? <ActivityIndicator size="small" color={colors.accent} accessibilityLabel="Aggiornamento previsioni" /> : <Text style={[styles.sourceLabel, { color: colors.muted }]}>{prediction.source === 'opening' ? 'Inizio frase' : prediction.source === 'context' ? 'Contesto + dizionario' : 'Dizionario'}</Text>}
          </View>
          <View style={styles.wordRow}>
            {words.length ? words.map((item, index) => (
              <Pressable key={`${item.word}-${index}`} accessibilityRole="button" accessibilityLabel={`Completa con ${item.word}`} onPress={() => complete(item.word)} style={({ pressed }) => [styles.wordButton, { backgroundColor: index === 0 ? colors.accentSoft : colors.surface, borderColor: index === 0 ? colors.accentSoft : colors.border }, pressed && styles.pressed]}>
                <Text numberOfLines={2} style={[styles.wordText, { color: index === 0 ? colors.accent : colors.ink }]}>{item.word}</Text>
              </Pressable>
            )) : <View style={[styles.emptyWords, { backgroundColor: colors.surfaceSubtle }]}><Text style={[styles.caption, { color: colors.muted }]}>{currentWord ? 'Continua a scrivere: ogni parola è possibile.' : 'Le parole suggerite compariranno qui.'}</Text></View>}
          </View>

          <View style={styles.lettersHeading}>
            <Text style={[styles.lettersTitle, textStyle]}>La prossima lettera</Text>
            <Text accessibilityLiveRegion="polite" accessibilityLabel={`${visibleLetters.length} lettere proposte, gruppo ${pageIndex + 1} di ${letterPages.length}, massimo ${maxLetters}`} style={[styles.caption, { color: colors.muted }]}>{visibleLetters.length} scelte · {pageIndex + 1}/{letterPages.length}</Text>
          </View>
          <View style={styles.letterGrid}>
            {Array.from({ length: gridRows }, (_, row) => <View key={row} style={styles.letterRow}>
              {Array.from({ length: gridColumns }, (_, col) => {
                const index = row * gridColumns + col;
                const item = slots[index];
                if (!item) return <View key={col} pointerEvents="none" accessible={false} style={styles.emptyLetterSlot} />;
                const display = capital ? item.letter.toLocaleUpperCase('it') : item.letter;
                const best = item.letter === bestLetter;
                return <Pressable key={col} accessibilityRole="button" accessibilityLabel={`Lettera ${display}${best ? pageIndex ? ', più probabile in questo gruppo' : ', più probabile' : ''}`} onPress={() => insert(item.letter)} style={({ pressed }) => [styles.letterKey, { backgroundColor: best ? colors.accent : colors.surface, borderColor: best ? colors.accent : colors.border }, pressed && styles.pressed]}>
                  <Text style={[styles.letter, { color: best ? colors.accentInk : colors.ink }]}>{display}</Text>
                  {best && <View style={[styles.bestDot, { backgroundColor: colors.accentInk }]} />}
                </Pressable>;
              })}
            </View>)}
          </View>
          <View style={[styles.moreRow, leftHand && { flexDirection: 'row-reverse' }]}>
            <Pressable disabled={letterPages.length < 2} accessibilityRole="button" accessibilityLabel={lastLetterPage ? 'Torna alle lettere più probabili' : 'Altre lettere: mostra le successive più probabili'} onPress={() => setLetterPage({ text, maxLetters, index: (pageIndex + 1) % letterPages.length })} style={({ pressed }) => [styles.moreKey, { backgroundColor: colors.accentSoft, borderColor: colors.border }, letterPages.length < 2 && styles.disabled, pressed && styles.pressed]}>
              <Text style={[styles.moreGlyph, { color: colors.accent }]}>{lastLetterPage ? '↶' : '→'}</Text>
              <Text style={[styles.moreLabel, { color: colors.accent }]}>{lastLetterPage ? 'Prime lettere' : 'Altre lettere'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="ABC: apri tutte le lettere, numeri e simboli" onPress={() => setAlphabetOpen(true)} style={({ pressed }) => [styles.alphabetKey, subtleButton, pressed && styles.pressed]}>
              <Text style={[styles.alphabetKeyText, textStyle]}>ABC</Text>
              <Text style={[styles.moreSmall, { color: colors.muted }]}>123</Text>
            </Pressable>
          </View>
          <View style={[styles.toolbar, leftHand && { flexDirection: 'row-reverse' }]}>
            <Pressable disabled={!historySize} accessibilityRole="button" accessibilityLabel="Annulla l'ultima modifica" onPress={undo} style={({ pressed }) => [styles.toolButton, subtleButton, !historySize && styles.disabled, pressed && styles.pressed]}><Text style={[styles.toolGlyph, textStyle]}>↶</Text><Text style={[styles.toolLabel, textStyle]}>Annulla</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Inserisci uno spazio" onPress={() => insert(' ')} style={({ pressed }) => [styles.spaceButton, subtleButton, pressed && styles.pressed]}><Text style={[styles.spaceLabel, textStyle]}>spazio</Text></Pressable>
            <Pressable disabled={!text} accessibilityRole="button" accessibilityLabel="Cancella l'ultimo carattere" onPress={removeLast} style={({ pressed }) => [styles.toolButton, subtleButton, !text && styles.disabled, pressed && styles.pressed]}><Text style={[styles.toolGlyph, textStyle]}>⌫</Text><Text style={[styles.toolLabel, textStyle]}>Cancella</Text></Pressable>
          </View>
          {!compact && <Text style={[styles.footerNote, { color: colors.muted }]}>La lettera evidenziata è la più probabile tra quelle mostrate.</Text>}
        </View>
      </ScrollView>

      <Modal visible={alphabetOpen} transparent animationType="slide" onRequestClose={() => setAlphabetOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.backdropTap} accessibilityRole="button" accessibilityLabel="Chiudi tutte le lettere" onPress={() => setAlphabetOpen(false)} />
          <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.sheet, { backgroundColor: colors.background, maxHeight: height * 0.92 }]}>
            <View style={styles.sheetHandleWrap}><View style={[styles.sheetHandle, { backgroundColor: colors.border }]} /></View>
            <View style={styles.sheetHeader}>
              <Text accessibilityRole="header" style={[styles.sheetTitle, textStyle]}>Tutte le lettere</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Torna alle lettere suggerite" onPress={() => setAlphabetOpen(false)} style={[styles.closeButton, subtleButton]}><Text style={[styles.closeText, textStyle]}>Fatto</Text></Pressable>
            </View>
            <View style={[styles.miniEditor, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text numberOfLines={2} style={[styles.miniEditorText, textStyle]}>{text.slice(-140) || 'Scrivi liberamente'}<Text style={{ color: colors.accent }}>│</Text></Text></View>
            <View accessibilityRole="tablist" style={styles.alphabetTabs}>
              {(['abc', '123', 'simboli'] as const).map((tab) => <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: alphabetTab === tab }} onPress={() => setAlphabetTab(tab)} style={[styles.alphabetTab, { backgroundColor: alphabetTab === tab ? colors.accent : colors.surfaceSubtle }]}><Text style={[styles.tabText, { color: alphabetTab === tab ? colors.accentInk : colors.ink }]}>{tab === 'abc' ? 'Lettere' : tab === '123' ? 'Numeri' : 'Simboli'}</Text></Pressable>)}
            </View>
            <ScrollView contentContainerStyle={styles.alphabetContent}>
              {grid.map((row, index) => <View key={index} style={styles.fullLetterRow}>{row.map((letter) => <Pressable key={letter} accessibilityRole="button" accessibilityLabel={`Inserisci ${capital ? letter.toLocaleUpperCase('it') : letter}`} onPress={() => insert(letter)} style={({ pressed }) => [styles.fullLetterKey, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}><Text style={[styles.fullLetterText, textStyle]}>{capital ? letter.toLocaleUpperCase('it') : letter}</Text></Pressable>)}</View>)}
              <View style={styles.fullLetterRow}>
                <Pressable accessibilityRole="button" accessibilityLabel={capital ? 'Prossima lettera minuscola' : 'Prossima lettera maiuscola'} accessibilityState={{ selected: capital }} onPress={() => setShift(!capital)} style={[styles.fullLetterKey, { flex: 1.2, backgroundColor: capital ? colors.accentSoft : colors.surfaceSubtle, borderColor: colors.border }]}><Text style={[styles.fullLetterText, textStyle]}>⇧</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Inserisci uno spazio" onPress={() => insert(' ')} style={[styles.fullLetterKey, { flex: 3, backgroundColor: colors.surfaceSubtle, borderColor: colors.border }]}><Text style={[styles.spaceLabel, textStyle]}>spazio</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Vai a capo" onPress={() => insert('\n')} style={[styles.fullLetterKey, { flex: 1.2, backgroundColor: colors.surfaceSubtle, borderColor: colors.border }]}><Text style={[styles.fullLetterText, textStyle]}>↵</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancella l'ultimo carattere" onPress={removeLast} style={[styles.fullLetterKey, { flex: 1.2, backgroundColor: colors.surfaceSubtle, borderColor: colors.border }]}><Text style={[styles.fullLetterText, textStyle]}>⌫</Text></Pressable>
              </View>
              <Text style={[styles.alphabetHint, { color: colors.muted }]}>Puoi scrivere anche nomi, parole nuove e indirizzi.</Text>
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      <Modal visible={settingsOpen} animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
          <View style={[styles.settingsPage, { maxWidth: 640 }]}>
            <View style={styles.sheetHeader}>
              <Text accessibilityRole="header" style={[styles.sheetTitle, textStyle]}>Il tuo Cinque</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Chiudi impostazioni" onPress={() => setSettingsOpen(false)} style={[styles.closeButton, subtleButton]}><Text style={[styles.closeText, textStyle]}>Fatto</Text></Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.settingsContent}>
              <View style={[styles.infoCard, { backgroundColor: colors.accentSoft }]}>
                <Text style={[styles.infoTitle, { color: colors.accent }]}>Le tue frasi restano qui.</Text>
                <Text style={[styles.bodyText, { color: colors.ink }]}>Previsioni statistiche offline, calcolate sul telefono. Vocabolario e sequenze sono già inclusi: nessun download aggiuntivo, account o servizio online.</Text>
              </View>
              <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
                <Text style={[styles.cardKicker, { color: colors.muted }]}>01 / VOCABOLARIO INCLUSO</Text>
                <Text style={[styles.infoTitle, textStyle]}>{lexiconCount.toLocaleString('it-IT')} forme di parola</Text>
                <Text style={[styles.bodyText, { color: colors.muted }]}>Già incluso nell’app, disponibile offline. Propone lettere e completamenti a partire dalla parola che stai scrivendo.</Text>
                <Text style={[styles.smallNote, { color: colors.muted }]}>Un dizionario ampio non contiene ogni nome o parola possibile: il pulsante ABC apre sempre l’alfabeto completo.</Text>
              </View>
              <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
                <Text style={[styles.cardKicker, { color: colors.muted }]}>02 / CONTESTO DELLA FRASE</Text>
                <Text style={[styles.infoTitle, textStyle]}>{contextCount.toLocaleString('it-IT')} sequenze italiane</Text>
                <Text style={[styles.bodyText, { color: colors.muted }]}>Sequenze apprese da frasi italiane. Le ultime {contextOrder === 3 ? 'tre' : contextOrder} parole guidano la continuazione; il testo della sessione aiuta ad adattare i suggerimenti.</Text>
                <Text style={[styles.smallNote, { color: colors.muted }]}>Il sistema confronta frequenze e sequenze di parole. Non interpreta il significato dell’intera frase: puoi sempre scegliere una lettera diversa.</Text>
              </View>
              <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
                <Text style={[styles.cardKicker, { color: colors.muted }]}>SCELTE ADATTIVE</Text>
                <Text style={[styles.infoTitle, textStyle]}>Da 4 a {maxLetters} lettere</Text>
                <Text style={[styles.bodyText, { color: colors.muted }]}>Il numero di lettere bilancia ricerca, distanza del pollice e tocchi su Altre. Riduce gli spostamenti dei tasti per aiutarti a ritrovarli.</Text>
                <Text style={[styles.preferenceTitle, textStyle]}>Massimo di lettere visibili</Text>
                <View accessibilityRole="radiogroup" style={styles.limitOptions}>
                  {[4, 6, 8, 10].map((limit) => <Pressable key={limit} accessibilityRole="radio" accessibilityLabel={`Massimo ${limit} lettere`} accessibilityState={{ checked: maxLetters === limit }} onPress={() => setMaxLetters(limit)} style={({ pressed }) => [styles.limitOption, { backgroundColor: maxLetters === limit ? colors.accent : colors.surfaceSubtle, borderColor: maxLetters === limit ? colors.accent : colors.border }, pressed && styles.pressed]}><Text style={[styles.limitText, { color: maxLetters === limit ? colors.accentInk : colors.ink }]}>{limit}</Text></Pressable>)}
                </View>
                <Text style={[styles.smallNote, { color: colors.muted }]}>Altre lettere scorre i suggerimenti dal più al meno probabile. Quando scrivi, riparte dal primo gruppo. ABC apre l’alfabeto completo, numeri e simboli.</Text>
              </View>
              <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
                <View style={styles.preferenceRow}><View style={{ flex: 1 }}><Text style={[styles.preferenceTitle, textStyle]}>Mano sinistra</Text><Text style={[styles.bodyText, { color: colors.muted }]}>Avvicina le lettere più usate al pollice sinistro e porta Cancella sullo stesso lato.</Text></View><Switch accessibilityLabel="Modalità mano sinistra" value={leftHand} onValueChange={setLeftHand} trackColor={{ false: colors.border, true: colors.accent }} /></View>
              </View>
              <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
                <Text style={[styles.cardKicker, { color: colors.muted }]}>FONTI E LICENZE</Text>
                <Text style={[styles.bodyText, { color: colors.muted }]}>Vocabolario e frequenze derivati da wordfreq: dati CC BY-SA 4.0.</Text>
                <Text style={[styles.bodyText, { color: colors.muted }]}>Sequenze derivate dalle frasi italiane di Tatoeba: CC BY 2.0 FR. Le attribuzioni dei collaboratori sono incluse nei file del progetto.</Text>
                <View style={styles.sourceLinks}>
                  <Pressable accessibilityRole="link" accessibilityLabel="Apri fonte wordfreq nel browser" onPress={() => openSource('https://github.com/rspeer/wordfreq')} style={styles.sourceLink}><Text style={[styles.copyText, { color: colors.accent }]}>wordfreq ↗</Text></Pressable>
                  <Pressable accessibilityRole="link" accessibilityLabel="Apri fonte Tatoeba nel browser" onPress={() => openSource('https://tatoeba.org')} style={styles.sourceLink}><Text style={[styles.copyText, { color: colors.accent }]}>Tatoeba ↗</Text></Pressable>
                  <Pressable accessibilityRole="link" accessibilityLabel="Apri licenza CC BY 2.0 FR nel browser" onPress={() => openSource('https://creativecommons.org/licenses/by/2.0/fr/')} style={styles.sourceLink}><Text style={[styles.copyText, { color: colors.accent }]}>Licenza ↗</Text></Pressable>
                </View>
              </View>
              <Text style={[styles.settingsFootnote, { color: colors.muted }]}>Usa Cinque sul telefono con Expo Go oppure con una build installabile. È un’app di scrittura: componi qui e copia il testo nelle altre app. La tastiera di sistema richiede estensioni native separate per iOS e Android.</Text>
            </ScrollView>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  mainScroll: { flex: 1 },
  screen: { flexGrow: 1, width: '100%', maxWidth: 620, alignSelf: 'center', paddingTop: 10, paddingBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandName: { fontSize: 31, fontWeight: '800', letterSpacing: -1.5 },
  brandMark: { height: 35, width: 35, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 5 },
  dotRow: { flexDirection: 'row', justifyContent: 'center', gap: 4 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  settingsButton: { minHeight: 44, paddingHorizontal: 13, justifyContent: 'center', borderWidth: 1, borderRadius: 18 },
  settingsText: { fontSize: 12, fontWeight: '600' },
  tagline: { marginTop: 12, fontSize: 16, letterSpacing: -0.2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 13, marginBottom: 16, minHeight: 25 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, flex: 1 },
  privateBadge: { fontSize: 11, fontWeight: '600' },
  editorCard: { flex: 1, borderRadius: 25, borderWidth: 1, padding: 18, overflow: 'hidden' },
  editorTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  eyebrow: { fontSize: 9, letterSpacing: 1.1, fontWeight: '700' },
  copyButton: { minHeight: 30, justifyContent: 'center', paddingHorizontal: 2 },
  copyText: { fontSize: 12, fontWeight: '700' },
  editorScroll: { flex: 1 },
  editorContent: { paddingBottom: 10 },
  composition: { fontSize: 27, lineHeight: 37, letterSpacing: -0.5 },
  editorBottom: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 10 },
  caption: { fontSize: 10, lineHeight: 15 },
  keyboard: { paddingTop: 20 },
  suggestionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 22, marginBottom: 7 },
  sourceLabel: { fontSize: 9 },
  wordRow: { flexDirection: 'row', gap: 7, minHeight: 51 },
  wordButton: { flex: 1, minHeight: 51, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, paddingVertical: 7 },
  wordText: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  emptyWords: { flex: 1, paddingHorizontal: 13, borderRadius: 15, justifyContent: 'center' },
  lettersHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 19, marginBottom: 10, gap: 8 },
  lettersTitle: { fontSize: 13, fontWeight: '600' },
  letterGrid: { gap: 9 },
  letterRow: { flexDirection: 'row', gap: 9 },
  letterKey: { flex: 1, minHeight: 64, borderWidth: 1, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  emptyLetterSlot: { flex: 1, minHeight: 64 },
  letter: { fontSize: 32, fontWeight: '600' },
  bestDot: { width: 3, height: 3, borderRadius: 2, position: 'absolute', bottom: 7 },
  moreRow: { flexDirection: 'row', marginTop: 10, gap: 9 },
  moreKey: { flex: 1, minHeight: 44, paddingHorizontal: 12, borderRadius: 15, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  alphabetKey: { width: 56, minHeight: 44, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 1 },
  alphabetKeyText: { fontSize: 12, fontWeight: '700' },
  moreGlyph: { fontSize: 25, fontWeight: '700', lineHeight: 25, letterSpacing: 1 },
  moreLabel: { fontSize: 13, fontWeight: '700' },
  moreSmall: { fontSize: 9, letterSpacing: 0.5 },
  toolbar: { flexDirection: 'row', gap: 9, marginTop: 10 },
  toolButton: { width: '24%', minHeight: 55, borderRadius: 17, justifyContent: 'center', alignItems: 'center', gap: 1 },
  toolGlyph: { fontSize: 22, lineHeight: 24 },
  toolLabel: { fontSize: 8 },
  spaceButton: { flex: 1, minHeight: 55, borderRadius: 17, justifyContent: 'center', alignItems: 'center' },
  spaceLabel: { fontSize: 14, fontWeight: '500' },
  footerNote: { fontSize: 9, textAlign: 'center', marginTop: 13, lineHeight: 13 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.35 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(5, 17, 10, 0.4)', justifyContent: 'flex-end' },
  backdropTap: { flex: 1 },
  sheet: { borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 17, width: '100%', maxWidth: 640, alignSelf: 'center', paddingBottom: 12 },
  sheetHandleWrap: { alignItems: 'center', paddingTop: 9, paddingBottom: 13 },
  sheetHandle: { width: 34, height: 4, borderRadius: 2 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 15 },
  sheetTitle: { fontSize: 24, fontWeight: '700', letterSpacing: -0.6, flexShrink: 1 },
  closeButton: { minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 17 },
  closeText: { fontSize: 13, fontWeight: '700' },
  miniEditor: { padding: 13, borderRadius: 17, minHeight: 70, borderWidth: 1, justifyContent: 'center' },
  miniEditorText: { fontSize: 19, lineHeight: 25 },
  alphabetTabs: { flexDirection: 'row', gap: 8, paddingVertical: 15 },
  alphabetTab: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 14 },
  tabText: { fontSize: 13, fontWeight: '600' },
  alphabetContent: { paddingBottom: 10, gap: 8 },
  fullLetterRow: { flexDirection: 'row', gap: 5 },
  fullLetterKey: { flex: 1, minHeight: 49, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  fullLetterText: { fontSize: 21, fontWeight: '500' },
  alphabetHint: { fontSize: 11, textAlign: 'center', paddingTop: 8, lineHeight: 17 },
  settingsPage: { flex: 1, paddingTop: 16, paddingHorizontal: 20, alignSelf: 'center', width: '100%' },
  settingsContent: { gap: 15, paddingBottom: 32 },
  infoCard: { borderRadius: 22, padding: 19, gap: 10 },
  infoTitle: { fontSize: 21, fontWeight: '700', letterSpacing: -0.5 },
  bodyText: { fontSize: 14, lineHeight: 21 },
  smallNote: { fontSize: 11, lineHeight: 17, marginTop: 3 },
  cardKicker: { fontSize: 9, letterSpacing: 1.1, fontWeight: '700' },
  preferenceRow: { flexDirection: 'row', alignItems: 'center', gap: 15 },
  preferenceTitle: { fontSize: 16, fontWeight: '600', marginBottom: 5 },
  limitOptions: { flexDirection: 'row', gap: 8 },
  limitOption: { flex: 1, minHeight: 48, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  limitText: { fontSize: 17, fontWeight: '700' },
  settingsFootnote: { fontSize: 11, lineHeight: 18, paddingHorizontal: 5 },
  sourceLinks: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 4 },
  sourceLink: { minHeight: 44, justifyContent: 'center' },
});
