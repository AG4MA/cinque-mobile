# Decisioni tecniche, versione 0.2

Cinque calcola lettere e completamenti interamente sul telefono. Dati, parametri e indici sono inclusi nell'app. Non serve un LLM, un account o un servizio di previsione. Il vocabolario deriva da wordfreq; il modello di contesto usa conteggi aggregati di frasi italiane Tatoeba. Le formule e i risultati riproducibili sono in [MATHEMATICS.md](MATHEMATICS.md).

## Probabilità e contesto

Il nuovo `ProbabilisticEngine` sostituisce nell'app la combinazione euristica dei punteggi. Usa distribuzioni normalizzate, contesto delle ultime tre parole e interpolazione gerarchica con sconto assoluto. Il prior considera frequenze lessicali e numero di predecessori distinti. È ispirato a Kneser Ney, ma non implementa Kneser Ney completo: gli ordini superiori usano conteggi grezzi e uno sconto unico.

I 150.000 contesti conservano 606.313 transizioni. Il totale originale di ciascun contesto viene mantenuto prima del taglio delle alternative: la massa eliminata torna al modello più generale. L'inizio frase mantiene tutte le continuazioni osservate e combina conteggi attenuati con frequenze lessicali, senza una lista di nomi vietati.

La personalizzazione segue un aggiornamento di tipo Dirichlet sul testo della composizione corrente. Conserva al massimo 512 parole complete e 16.384 caratteri precedenti; cancellazione e annullamento rimuovono le osservazioni corrispondenti. Non è una memoria persistente dell'utente. Il contesto non interpreta il significato di una frase arbitrariamente lunga.

Gli indici ordinati per prefisso, le somme cumulative e un albero dei massimi evitano di scandire il dizionario a ogni tocco. Questo trasferisce parte del lavoro all'avvio: sul computer del benchmark la costruzione degli oggetti passa da circa 40 a 592 ms, con JSON già analizzato. Non è una misura dell'avvio completo sul telefono.

## Scelte e disposizione

Il numero di lettere minimizza un costo atteso di ricerca, movimento, pagine aggiuntive e correzione. Rimangono almeno quattro scelte; il massimo predefinito è otto, regolabile a quattro, sei, otto o dieci. I coefficienti di Fitts, Hick e degli errori sono ipotesi tecniche dichiarate, non tempi misurati sull'utente.

La griglia riserva gli spazi del massimo configurato. Tutti i tasti hanno altezza minima di 64 punti; con otto spazi usa due righe di quattro. La disposizione avvicina le opzioni probabili al pollice e considera la mano scelta. Una ricerca esatta fra le assegnazioni, con penalità di spostamento, limita i cambiamenti inutili. Un vantaggio stimato inferiore a 18 ms non cambia la disposizione stabile di riferimento.

«Altre lettere» scorre gruppi ordinati per probabilità. Solo l'ultimo gruppo può ripetere lettere per mantenere almeno quattro tasti. Digitazione, completamento, cancellazione, annullamento e modifica del massimo riportano al primo gruppo. Il piccolo pulsante «ABC» apre tutte le lettere, numeri e simboli. Nessuna previsione può impedire di scrivere una lettera diversa.

## Validazione e limiti

La divisione deterministica delle frasi deduplicate assegna circa il 90% a TRAIN, il 5% a DEV e il 5% a TEST. I parametri sono scelti solo su DEV e poi congelati. Il confronto finale usa 4.800 posizioni TEST: la lettera corretta nel primo gruppo passa dall'87,875% all'88,792%, con 5,63 tasti medi invece di 5,83. La probabilità non diventa una garanzia sulla prossima intenzione dell'utente.

Il risultato aggregato non implica miglioramento in ogni situazione. TEST esclude frasi presenti nell'addestramento di entrambi i motori; il vecchio motore includeva invece il nuovo DEV, quindi non è stato usato per selezionare i parametri. Parafrasi simili e sovrapposizioni con wordfreq possono restare. Tatoeba non rappresenta una chat personale. I tocchi simulati e i tempi desktop non dimostrano maggiore velocità di scrittura umana o prestazioni sul telefono.

## Runtime e privacy

Il precedente errore iPhone `Iterator value must be an object` era riproducibile in Hermes con grandi array JavaScript letterali. I moduli generati caricano stringhe tramite `JSON.parse`; il test Hermes verifica dati e motori reali. L'app registra React prima di caricare i dati e offre un errore recuperabile in caso di avvio fallito.

La diagnostica di sviluppo invia al computer della stessa LAN soltanto eventi tecnici, fasi di avvio, errori, tempi e numero di scelte o pagine. Esclude testo digitato, suggerimenti e clipboard. È disattivata in produzione. L'inferenza e la personalizzazione non richiedono rete; l'uso di Expo Go durante lo sviluppo richiede invece il server di sviluppo per caricare il progetto.

## Distribuzione e attribuzioni

Expo condivide l'app tra Android e iOS. Questa versione è un editor: si compone qui e si copia il testo nelle altre app. La tastiera di sistema richiederebbe un servizio Android `InputMethodService` e una Keyboard Extension iOS, oltre a build native proprie. La pubblicazione del repository non aggiunge queste estensioni. Riferimenti: [Expo](https://docs.expo.dev/develop/development-builds/faq/), [Android](https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method), [Apple](https://developer.apple.com/documentation/uikit/creating-a-custom-keyboard).

I dati wordfreq mantengono la licenza CC BY-SA 4.0. Le frasi e i conteggi derivati da Tatoeba mantengono l'attribuzione a Tatoeba e ai contributori e la licenza CC BY 2.0 FR. Snapshot, trasformazioni e hash sono nei metadati; i contributori sono in `assets/context/CONTRIBUTORS.txt`. Riferimenti: [wordfreq](https://github.com/rspeer/wordfreq), [snapshot Tatoeba](https://downloads.tatoeba.org/exports/per_language/ita/), [attribuzione Tatoeba](https://en.wiki.tatoeba.org/articles/show/faq#i-would-like-to-use-data-from-tatoeba-for-my-project.-how-do-i-give-proper-attribution?), [licenza delle frasi](https://creativecommons.org/licenses/by/2.0/fr/).
