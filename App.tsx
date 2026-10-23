import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import KeyboardScreen from './src/components/KeyboardScreen';
import type { Entry } from './src/prediction/lexical-engine';
import { ProbabilisticEngine, type ProbabilityDataset } from './src/prediction/probabilistic-engine';
import calibration from './src/prediction/calibration.json';
import { reportDiagnostic, reportDiagnosticError } from './src/diagnostics';

function loadEngine() {
  const started = Date.now();
  reportDiagnostic('boot_stage', { stage: 'lexicon_load' });
  const vocabulary = require('./assets/runtime/lexicon.js') as { entries: Entry[] };
  reportDiagnostic('boot_stage', { stage: 'probability_load', entryCount: vocabulary.entries.length });
  const contextData = require('./assets/runtime/probability.js') as ProbabilityDataset;
  reportDiagnostic('boot_stage', { stage: 'engine_create', contextCount: contextData.contexts.length });
  const engine = new ProbabilisticEngine(vocabulary.entries, contextData, calibration.options);
  engine.predict('');
  reportDiagnostic('engine_ready', { durationMs: Date.now() - started, entryCount: engine.lexical.count, contextCount: engine.contextCount });
  return engine;
}

function ReadyKeyboard({ engine }: { engine: ProbabilisticEngine }) {
  const [text, setText] = useState('');
  const [prediction, setPrediction] = useState(() => engine.predict(''));
  useEffect(() => { reportDiagnostic('app_ready'); }, []);
  const changeText = useCallback((next: string) => {
    setText(next);
    const started = Date.now();
    setPrediction(engine.predict(next));
    reportDiagnostic('prediction', { durationMs: Date.now() - started });
  }, [engine]);
  const copy = useCallback(async () => {
    const success = await Clipboard.setStringAsync(text);
    if (!success) throw new Error('Non è stato possibile copiare il testo.');
  }, [text]);

  return <KeyboardScreen
        text={text} onTextChange={changeText} prediction={prediction} onCopy={copy}
        lexiconCount={engine.lexical.count} contextCount={engine.contextCount} contextOrder={engine.contextOrder}
      />;
}

class KeyboardBoundary extends React.Component<React.PropsWithChildren<{ onRetry: () => void }>, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { reportDiagnosticError(error, 'react_boundary'); }
  render() {
    return this.state.failed ? <Startup failed onRetry={this.props.onRetry} /> : this.props.children;
  }
}

function Startup({ failed = false, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  return <View style={styles.startup}>
    <Text style={styles.title}>Cinque</Text>
    {failed ? <>
      <Text style={styles.message}>La tastiera non è riuscita ad avviarsi.</Text>
      <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retry}><Text style={styles.retryText}>Riprova</Text></Pressable>
    </> : <>
      <ActivityIndicator size="large" color="#235C43" />
      <Text style={styles.message}>Preparo il vocabolario italiano…</Text>
    </>}
  </View>;
}

export default function App() {
  const [attempt, setAttempt] = useState(0);
  const [engine, setEngine] = useState<ProbabilisticEngine | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // Register and render the app before loading the full offline datasets.
    const timer = setTimeout(() => {
      try { setEngine(loadEngine()); }
      catch (error) { reportDiagnosticError(error, 'engine_startup'); setFailed(true); }
    }, 0);
    return () => clearTimeout(timer);
  }, [attempt]);
  const retry = () => { setEngine(null); setFailed(false); setAttempt(value => value + 1); };
  return <SafeAreaProvider>
    <StatusBar style="auto" />
    <KeyboardBoundary key={attempt} onRetry={retry}>
      {engine ? <ReadyKeyboard engine={engine} /> : <Startup failed={failed} onRetry={retry} />}
    </KeyboardBoundary>
  </SafeAreaProvider>;
}

const styles = StyleSheet.create({
  startup: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, padding: 28, backgroundColor: '#F3F5F0' },
  title: { fontSize: 36, fontWeight: '700', color: '#172A23' },
  message: { fontSize: 17, textAlign: 'center', color: '#172A23' },
  retry: { backgroundColor: '#235C43', paddingVertical: 16, paddingHorizontal: 28, borderRadius: 18 },
  retryText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
});
