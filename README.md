# Cinque

Tastiera italiana a una mano per Android e iPhone, sviluppata con Expo. Previsioni, adattamento alla composizione e scelta dei tasti si calcolano sul telefono. Vocabolario e modello statistico sono inclusi nell'app.

## Avvio

Con Node.js 24 o successivo:

```sh
npm ci
npm start
```

Apri il progetto con Expo Go compatibile con SDK 57, usando il QR mostrato dal terminale. Computer e telefono devono essere sulla stessa rete. Expo Go carica il progetto dal computer; una build installabile include il bundle e funziona senza il server di sviluppo.

```sh
npm run build:android
npm run build:ios
```

Le build EAS richiedono un proprio account Expo. La distribuzione iOS richiede la firma Apple appropriata. Il repository non contiene credenziali, certificati o una build firmata.

Cinque è un'app di scrittura con funzione Copia. Per usarla come tastiera di sistema nelle altre app servono un servizio Android e una Keyboard Extension iOS, non inclusi in questa versione.

## Come si usa

* La griglia mostra almeno quattro lettere. Il massimo si sceglie fra quattro, sei, otto e dieci.
* I tasti delle lettere hanno dimensioni uguali. Otto scelte occupano due righe da quattro.
* **Altre lettere** scorre i gruppi successivi ordinati per probabilità. L'ultimo gruppo offre **Prime lettere**.
* Il piccolo pulsante **ABC** apre alfabeto completo, numeri e simboli.
* Una modifica del testo riporta al primo gruppo. I completamenti inseriscono la parola e uno spazio.
* Sono disponibili cancellazione, annulla, maiuscole, mano sinistra e copia.

## Matematica applicata

La versione 0.2 usa probabilità normalizzate, il prefisso corrente, fino a tre parole precedenti e un adattamento bayesiano alla composizione in corso. Il modello conserva i denominatori completi: le continuazioni omesse lasciano massa al contesto più breve. Un indice dei prefissi evita di scandire il vocabolario a ogni tocco.

Il numero di lettere minimizza un costo atteso di ricerca, movimento, cambio di gruppo e correzione. La disposizione considera la geometria del pollice e penalizza lo spostamento delle lettere già visibili. I coefficienti ergonomici sono stime iniziali: un minor costo stimato non dimostra da solo una maggiore velocità umana.

La calibrazione usa frasi distinte dal test finale. Vedi [matematica e verifiche](docs/MATHEMATICS.md) e [confronto riproducibile con la versione precedente](assets/evaluation/benchmark.json).

## Dati e privacy

* 316.423 forme di parola da wordfreq 3.1.1 e contesti dallo snapshot italiano Tatoeba del 10 ottobre 2026.
* Testo e apprendimento personale restano nella memoria dell'app. Modificare o annullare una frase ricalcola l'adattamento. Chiudere l'app lo elimina.
* Le previsioni non chiamano API, servizi online o modelli remoti.
* In sviluppo `npm start` avvia una diagnostica sulla LAN, porta 8082. Registra avvio, errori tecnici, tempi e quantità di scelte. Esclude testo, suggerimenti e clipboard. I log restano in `work/diagnostics/`, esclusa da Git, con massimo 1.000 eventi e circa 1 MB.
* La diagnostica è disattivata nelle build di produzione. In sviluppo richiede il collegamento al computer e non può registrare arresti nativi precedenti all'avvio JavaScript.

Il vocabolario non contiene ogni parola possibile. Tatoeba comprende frasi didattiche, traduzioni e nomi ricorrenti: i risultati sul corpus non rappresentano automaticamente le conversazioni quotidiane. Il contesto statistico non comprende semanticamente frasi arbitrariamente lunghe.

## Verifiche

```sh
npm run typecheck
npm test
npx expo export --platform all
```

Per la verifica nativa, imposta `HERMES_BIN` a una VM Hermes eseguibile e avvia `npm run test:hermes`. Il binario non è distribuito. I grandi dataset sono caricati con `JSON.parse` per evitare la corruzione degli array letterali riscontrata su Hermes. `npm ci`, `npm start` e `npm test` rigenerano i moduli in `assets/runtime/`.

## Riproduzione dei dati

Gli asset compilati sono inclusi. Rigenerarli richiede Python e lo snapshot originale, verificato tramite SHA256:

```sh
python scripts/build_probability_model.py --source /percorso/ita_sentences_detailed.tsv.bz2
python scripts/extract_probability_eval.py --source /percorso/ita_sentences_detailed.tsv.bz2
npm run evaluate:calibrate
npm run evaluate:test
node scripts/prepare-runtime-data.mjs
```

Il download settimanale Tatoeba cambia: gli script rifiutano hash diversi. Vecchio motore e asset restano nel repository per riprodurre il confronto, ma non sono caricati dall'app.

## Attribuzioni

* [wordfreq](https://github.com/rspeer/wordfreq), Robyn Speer: dati CC BY-SA 4.0. Attribuzioni, NOTICE e licenze in `assets/lexicon/`.
* [Tatoeba](https://tatoeba.org), contributori del corpus italiano: dati CC BY 2.0 FR. Crediti e licenza in `assets/context/`; trasformazioni in `assets/probability/`.

Le licenze citate si applicano ai dataset. Al codice non è stata ancora assegnata una licenza di riutilizzo. Conservare attribuzioni e testi delle licenze quando si ridistribuiscono i dati.
