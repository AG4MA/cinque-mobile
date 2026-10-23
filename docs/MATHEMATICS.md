# Matematica di Cinque 0.2

Implementazione: `src/prediction/probabilistic-engine.ts`, `probability-index.ts`, `keyboard-cost.ts` e `adaptive-letters.ts`. Parametri congelati: `src/prediction/calibration.json`. Risultati: `assets/evaluation/benchmark.json`.

## Dalle parole alle lettere

Siano \(w\) una parola, \(h\) le ultime tre parole complete e \(u\) il prefisso scritto. Il modello generale combina distribuzioni normalizzate: frequenze wordfreq \(L\), predecessori distinti \(C\) e frequenze Tatoeba \(U\).

\[
P_0(w)=0{,}995[0{,}5L(w)+0{,}5C(w)]+0{,}005U(w).
\]

Per ciascun contesto si conserva il totale completo \(N_h\), anche quando alcune continuazioni sono eliminate. Per le sole alternative conservate \(R_h\):

\[
a_h(w)=0{,}8\frac{\max(c_h(w)-0{,}75,0)}{N_h},\qquad
P_h(w)=a_h(w)+\left(1-\sum_{v\in R_h}a_h(v)\right)P_{\text{precedente}}(w).
\]

Fuori da \(R_h\), \(a_h(w)=0\). Il procedimento parte dal modello generale e applica i contesti disponibili dal più breve al più lungo. Il totale pieno impedisce che il taglio delle alternative produca falsa sicurezza. Questo è **backoff interpolato gerarchico con sconto assoluto e prior di continuazione**, non Kneser Ney completo: gli ordini superiori non usano i suoi conteggi di continuazione e lo sconto è unico.

All'inizio frase si usa un prior distinto: peso della parola proporzionale a \(c_{inizio}(w)^{0{,}8}\max(L_{grezzo}(w),10^{-9})^{0{,}25}\), poi normalizzato e mescolato per il 95% con il 5% del modello generale. Il fattore attenua le ripetizioni specifiche del corpus senza vietare nomi.

La massa della prossima lettera somma **tutte** le parole compatibili, non soltanto i completamenti visibili:

\[
p(\ell\mid h,u,\text{continuazione})=
\frac{\sum_{w\text{ inizia con }u\ell}P_h(w)}
{\sum_{w\text{ inizia con }u,\ |w|>|u|}P_h(w)}.
\]

Un piccolo prior lessicale di massa 0,001 mantiene raggiungibili i 33 simboli del supporto, lettere e apostrofo, anche per parole sconosciute. La probabilità di fine parola è calcolata separatamente.

## Personalizzazione e calibrazione

La composizione corrente aggiorna la distribuzione mediante conteggi personali \(n\) e un prior Dirichlet:

\[
P_{personale}(w)=\frac{n(w)+\alpha P(w)}{N+\alpha}.
\]

Si usa \(\alpha=512\) per parole personali lunghe almeno quattro lettere e \(\alpha=12\) per i contesti personali. Il procedimento applica prima le parole e poi i contesti disponibili. La memoria è limitata al testo corrente, alle ultime 512 parole complete e a 16.384 caratteri. Annullare o cancellare ricostruisce i conteggi; chiamare ripetutamente la previsione non equivale a un nuovo esempio.

La calibrazione considera:

\[
p_T(\ell)=\frac{p(\ell)^{1/T}}{\sum_jp(j)^{1/T}}.
\]

Su DEV sono state confrontate 27 combinazioni dei tre pesi e otto temperature, minimizzando la perdita logaritmica media della prossima lettera. La combinazione scelta è `lexicalMix=0.5`, `openingMix=0.95`, `contextStrength=0.8`, `temperature=1`. Una temperatura pari a uno significa che **non è stata applicata una correzione termica**. Non certifica una calibrazione perfetta. Fine parola e suggerimenti di parole complete non sono calibrati da questo passaggio.

## Calcolo rapido e disposizione

Le parole sono ordinate per prefisso. Ricerca binaria e somme cumulative ricavano la massa di un intervallo senza scandirlo; un albero dei massimi restituisce i cinque completamenti migliori. Il costo delle ricerche di intervallo è logaritmico nella dimensione del vocabolario, con alfabeto e numero di completamenti limitati. La cache conserva al massimo 512 prefissi.

L'incertezza usa l'entropia di Shannon:

\[
H(p)=-\sum_i p_i\log_2p_i.
\]

Per ogni numero di tasti \(k\), da quattro al massimo configurato, il selettore stima il costo su tutte le pagine ordinate:

\[
C(k)=\sum_i p_i\left(T_{ricerca,i}+T_{tocco,i}+T_{pagine,i}+T_{correzione,i}+T_{spostamento,i}\right),\qquad
k^*=\arg\min_k C(k).
\]

La ricerca combina Hick e Hyman: `70 + 65 × (0,5 log2(k+1) + 0,5 H) + 5k` millisecondi per pagina. Il tocco usa Fitts: `55 + 80 log2(1+d/w)` millisecondi, con distanza dal punto di riposo del pollice e dimensione utile del bersaglio. Ogni cambio pagina aggiunge 240 ms. Una stima di errore limitata all'8% moltiplica un costo di correzione di 850 ms. I valori esatti e le penalità di movimento sono nel file `keyboard-cost.ts`.

Sono **ipotesi di progetto**, non coefficienti stimati su persone. La mano sinistra rispecchia la geometria; una programmazione dinamica con al massimo \(10\cdot2^{10}\) stati cerca l'assegnazione globale dei tasti. Mantiene la disposizione stabile se il guadagno stimato non raggiunge 18 ms. Il selettore modella il percorso con «Altre»; la misura di tocchi del benchmark considera anche il percorso «ABC».

## Protocollo e benchmark finale

Snapshot Tatoeba del 10 ottobre 2026, SHA256 `05853b510a67ad0615b993e29ae7cecb482af12524a52b9646dcfe76ea29afa3`. Le sequenze normalizzate identiche sono deduplicate. I primi otto byte del loro SHA256, interpretati come intero e ridotti modulo 20, assegnano il gruppo 0 a TEST, 1 a DEV e 2..19 a TRAIN. La proporzione nominale è 90/5/5: 817.943 sequenze TRAIN, 45.415 DEV e 45.160 TEST.

La selezione dei parametri usa 2.400 posizioni DEV. TEST contiene 4.800 posizioni: 800 per ognuno dei sei strati ottenuti da inizio o corpo della frase e prefisso di zero, una o due lettere. I risultati sono medie macro dei sei strati, non ponderazioni della frequenza d'uso reale. I bersagli già completamente rivelati dal prefisso sono esclusi. I parametri sono congelati prima di leggere TEST; hash di codice, campioni e dati sono nel report.

| Misura su TEST | Versione precedente | Versione 0.2 |
|:---|---:|---:|
| Lettera corretta nel primo gruppo | 87,875% | 88,792% |
| Tasti medi nel primo gruppo | 5,825 | 5,629 |
| Lettera nei primi quattro posti | 78,167% | 80,188% |
| Lettera nei primi otto posti | 89,688% | 90,333% |
| Parola nei primi tre suggerimenti | 51,458% | 53,604% |
| Perdita logaritmica lettere, nats, minore è meglio | 1,6111 | 1,4833 |
| Brier multiclasse, minore è meglio | 0,6288 | 0,5885 |
| Errore di calibrazione top1, dieci intervalli | 3,333% | 1,751% |
| Tocchi ideali per lettera, con ABC | 1,1213 | 1,1121 |
| Tocchi seguendo solo le pagine ordinate | 1,1421 | 1,1267 |
| Previsione desktop, mediana | 0,0780 ms | 0,0179 ms |
| Previsione desktop, percentile 95 | 4,0791 ms | 0,1117 ms |
| Costruzione del motore desktop, JSON già analizzato | 39,57 ms | 592,16 ms |

Il guadagno del primo gruppo è di 0,917 punti percentuali; l'intervallo bootstrap al 95% della differenza è da 0,343 a 1,508 punti. Il bootstrap usa 1.000 repliche e raggruppa per sequenza, mantenendo insieme i prefissi correlati. Non misura gli errori dovuti al dominio del corpus.

Non tutte le condizioni migliorano: per esempio, nel gruppo degli inizi con due lettere la copertura del primo gruppo scende di 0,125 punti mentre diminuiscono i tasti. L'avvio costruisce più indici ed è più lento. I tempi sono di un singolo processo desktop e dipendono da cache e ambiente; non includono l'intero avvio né misurano il telefono. I tocchi sono percorsi ideali, senza ricerca visiva, correzioni, apprendimento o completamento di parole. Non sono velocità umana.

Il vecchio motore era addestrato anche sul nuovo DEV, quindi il suo risultato DEV sarebbe contaminato ed è escluso dalla selezione. TEST è escluso dall'addestramento di entrambi. Possono però restare parafrasi simili; wordfreq è un corpus esterno e può sovrapporsi alle frasi valutate. Tatoeba contiene esempi e traduzioni, non conversazioni private rappresentative. Le licenze e le attribuzioni sono descritte in [DECISIONS.md](DECISIONS.md).

## Riproduzione

Con Node, dipendenze installate e artefatti inclusi, `npx tsx scripts/evaluate_probability.ts --test` verifica gli hash della calibrazione congelata e rigenera il confronto. I tempi possono cambiare; il campionamento e le misure predittive sono deterministici.

Per ricostruire i dati, usare lo snapshot con l'hash indicato e sostituire `PERCORSO_SNAPSHOT` con il suo percorso:

```text
python scripts/build_probability_model.py --source PERCORSO_SNAPSHOT
python scripts/extract_probability_eval.py --source PERCORSO_SNAPSHOT
node scripts/prepare-runtime-data.mjs
npx tsx scripts/evaluate_probability.ts --calibrate
npx tsx scripts/evaluate_probability.ts --test
```

`--calibrate` riscrive intenzionalmente l'artefatto dei parametri e legge soltanto DEV. Dopo qualsiasi modifica motivata da TEST, quel TEST non va più presentato come nuova prova indipendente; occorre un ulteriore insieme riservato.
