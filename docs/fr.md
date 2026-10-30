# BSB-LAN pour Gladys

Affiche votre **chaudière ou pompe à chaleur à régulateur Siemens** (ELCO,
Brötje, Baxi, MHG, Atlantic, Thision…) dans Gladys par l'adaptateur
**BSB-LAN**, relié au bus BSB, LPB ou PPS du régulateur : sans cloud, sans
compte, directement sur votre réseau.

> **Module jamais testé avec un vrai adaptateur.**
> Sans lien avec le projet BSB-LAN ni avec les fabricants. Il lit l'API JSON
> de BSB-LAN comme la bibliothèque python-bsblan (utilisée par Home
> Assistant).

> **Sécurité : BSB-LAN parle en http simple.** La clé de passe, l'identifiant
> et le mot de passe circulent en clair sur votre réseau local. Gardez
> l'adaptateur sur un **réseau de confiance**, jamais exposé sur Internet.

## Ce qu'il faut

- Un adaptateur BSB-LAN (carte Arduino Due ou ESP32) avec un micrologiciel
  qui donne sa version d'API JSON (`/JV`, version 1.0 au moins) : les
  versions récentes de BSB-LAN le font.
- Son adresse IP, fixe de préférence (réglez-la dans votre box).
- Pour les commandes : l'écriture sur le bus autorisée dans la configuration
  de BSB-LAN (`DEFAULT_FLAG 0`, ou l'écriture activée dans ses réglages).

## Ce que vous obtenez

Un appareil « Chauffage (BSB-LAN) » par adaptateur, reconnu par son adresse
MAC (il reste le même si l'adresse IP change). Chaque fonctionnalité
n'apparaît que si le régulateur en donne la valeur :

| Fonctionnalité                         | Paramètre | Contenu                                              |
| -------------------------------------- | --------- | ---------------------------------------------------- |
| Mode de chauffage                      | 700       | Liste (commande), voir plus bas                      |
| Mode de chauffage (lu)                 | 700       | Texte : le mode réel, y compris un mode inconnu      |
| État du circuit de chauffage           | 8000      | Texte du régulateur (« Chauffage confort »…)         |
| Consigne confort                       | 710       | Thermostat, circuit 1, en °C (commande)              |
| Consigne réduite                       | 712       | Thermostat, circuit 1, en °C (commande)              |
| Température de la pièce                | 8740      | En °C                                                |
| Consigne de départ                     | 8744      | En °C, circuit 1                                     |
| Température de départ                  | 8743      | En °C, circuit 1                                     |
| Mode de chauffage (circuit 2)          | 1000      | Liste (commande), si le régulateur a un circuit 2    |
| Mode de chauffage, lu (circuit 2)      | 1000      | Texte                                                |
| État du circuit de chauffage 2         | 8001      | Texte du régulateur                                  |
| Consigne confort (circuit 2)           | 1010      | Thermostat, en °C (commande)                         |
| Consigne réduite (circuit 2)           | 1012      | Thermostat, en °C (commande)                         |
| Consigne / température de départ (c.2) | 8774/8773 | En °C                                                |
| Température extérieure                 | 8700      | En °C                                                |
| Mode de l'eau chaude (commande)        | 1600      | Liste : marche, éco, arrêt                           |
| Mode de l'eau chaude                   | 1600      | Texte : arrêt, marche, éco                           |
| État de l'eau chaude                   | 8003      | Texte du régulateur                                  |
| Consigne d'eau chaude                  | 1610      | Chauffe-eau, en °C (commande, plafonnée)             |
| Consigne réduite de l'eau chaude       | 1612      | Chauffe-eau, en °C (commande, plafonnée)             |
| Température de l'eau chaude            | 8830      | En °C                                                |
| Pompe d'eau chaude en marche           | 8820      | 0 ou 1                                               |
| État de la chaudière                   | 8005      | Texte du régulateur                                  |
| Température de la chaudière            | 8310      | En °C                                                |
| Signal 1re allure du brûleur           | 7881      | 0 ou 1 (lecture seule)                               |
| Entrée défaut brûleur S3               | 7870      | 0 ou 1 (lecture seule)                               |
| Dernier défaut : date / code           | 6800/6801 | Textes du régulateur                                 |
| Énergie apportée (kWh)                 | 3113      | En kWh, simple valeur (voir plus bas)                |
| BSB <numéro> <nom>                     | au choix  | Paramètres supplémentaires, lecture seule (plus bas) |

**Circuit 2** : il n'apparaît que si le régulateur donne une valeur pour son
mode (1000) ; absent ou « --- », l'intégration ne lit plus que ce seul
paramètre à chaque lecture. Pas d'option pour le forcer : un circuit que le
régulateur ne donne pas ne peut pas être réglé, et la détection évite
d'écrire sur un circuit qui n'existe pas. **Eau chaude** : ses
fonctionnalités n'apparaissent que si le régulateur en donne les valeurs.

Les appareils créés avant la version 0.2.0 gardent leurs anciennes
fonctionnalités « Consigne réduite » et « Consigne réduite de l'eau chaude »
en lecture seule (toujours mises à jour) ; les versions réglables arrivent
à côté, à ajouter depuis l'onglet Découverte. Les nouveaux appareils n'ont
que les versions réglables.

Les numéros 7870, 7881, 6800, 6801, 8005 et 8310 sont ceux de la liste de
paramètres de BSB-LAN ; leur forme exacte dépend du régulateur. Chaque
valeur est vérifiée à la lecture : une valeur absente ou d'une autre forme
n'est pas publiée.

### Paramètres supplémentaires (lecture seule)

Le champ **Paramètres supplémentaires à lire** accepte jusqu'à 10 numéros de
paramètres BSB-LAN séparés par des virgules (par exemple `8326, 8338`).
Chacun devient une fonctionnalité **en lecture seule**, nommée « BSB
<numéro> <nom donné par BSB-LAN> », d'après la réponse de BSB-LAN à sa
première valeur : une température en °C devient une sonde, un autre nombre
une valeur simple (l'unité dans le nom), une liste ou un texte un texte. Si
la forme de la valeur change ensuite, elle n'est plus publiée. Ces
paramètres ne sont **jamais écrits** : il n'y a pas d'écriture libre. Les
numéros déjà lus par l'intégration, en double, au-delà de 10 ou mal saisis
sont ignorés et listés dans l'état de l'intégration. Chaque paramètre
allonge chaque lecture (l'adaptateur interroge le bus un paramètre après
l'autre).

Lire des catégories entières (`/JK=ALL`) n'est pas proposé : des centaines de
paramètres, une réponse trop grosse, une lecture du bus de plusieurs minutes
et autant de fonctionnalités dans Gladys.

La température extérieure, celle de l'eau et les consignes en lecture seule
sont des « sondes » : elles ne comptent pas comme température de la pièce
dans Gladys. Lecture toutes les 30 secondes par défaut (de 10 s à 10 min,
réglable), quelques paramètres par requête (l'adaptateur interroge le bus un
paramètre après l'autre).

Sur un bus **PPS** (thermostats d'ambiance simples), l'intégration lit le
mode, la consigne, la température de la pièce et la température extérieure,
**en lecture seule** dans cette version : la consigne y est une simple
sonde « Consigne de la pièce (lue) » (paramètre 15004), jamais un
thermostat que Gladys pourrait régler.

### Énergie : une simple valeur, pas un compteur facturé

Le paramètre 3113 (« énergie apportée ») est un texte du régulateur
(« 7968 kWh ») dont ni la résolution ni les remises à zéro ne sont
documentées. Gladys compterait chaque hausse d'un index comme une
consommation facturée : la valeur est donc publiée comme un **simple
capteur** (l'unité est dans son nom), jamais comme un index d'énergie. Elle
n'apparaît pas dans le suivi de consommation de Gladys.

## Installation

1. Installez l'intégration depuis le store de Gladys.
2. Dans sa configuration, saisissez l'**adresse IP de BSB-LAN** (port 80 par
   défaut ; ajoutez `:port` s'il est différent).
3. Si votre BSB-LAN en a une, saisissez la **clé de passe** (« Passkey », la
   première partie de ses adresses, sans les barres obliques), et
   l'**identifiant** et le **mot de passe** de son authentification HTTP.
   Les deux champs secrets sont gardés par Gladys dans sa base, jamais
   réaffichés, envoyés seulement à l'adaptateur.
4. Enregistrez, puis ajoutez l'appareil depuis l'onglet **Découverte**.

Le bouton **Tester la connexion** lit l'adaptateur une fois (au plus toutes
les 10 secondes), même après des identifiants refusés.

## Commandes (désactivées par défaut)

Tant que l'option **Autoriser les commandes** est désactivée, toute commande
est refusée, **sauf Protection (hors-gel) et eau chaude à l'arrêt** (plus
bas). Activée, Gladys peut changer :

- le **mode de chauffage** des circuits 1 et 2 : automatique (programme
  horaire), confort, réduit, protection (hors-gel) ;
- la **consigne confort** de chaque circuit (710, 1010), au dixième de degré,
  jamais sous sa consigne réduite (712, 1012) ni sa consigne de protection
  (714, 1014), jamais au-dessus de sa consigne confort maximale (716, 1016),
  et toujours entre 5 et 35 °C ;
- la **consigne réduite** de chaque circuit (712, 1012), au dixième de degré,
  jamais sous la consigne de protection (714, 1014), jamais au-dessus de la
  consigne confort (710, 1010) ni du maximum (716, 1016), entre 5 et 35 °C ;
- le **mode de l'eau chaude** (1600) : marche, éco, arrêt ;
- la **consigne d'eau chaude** (1610), en degrés entiers, entre la consigne
  réduite (1612) et le maximum du régulateur (1614), jusqu'au **plafond** ;
- la **consigne réduite de l'eau chaude** (1612), en degrés entiers, de 10 °C
  jusqu'à la plus basse de la consigne d'eau chaude (1610), du maximum
  (1614), du plafond et de 65 °C.

### Protection et eau chaude à l'arrêt : jamais bloquées

Le mode **Protection (hors-gel)** des circuits 1 et 2 et le mode **Arrêt** de
l'eau chaude font office d'arrêt : ils partent **même sans l'option**,
pendant une pause (429/5xx), après des identifiants refusés, pendant une
autre commande, sans relecture préalable, et depuis un mode inconnu. Ils
passent avant toute requête en attente et annulent les commandes pas
encore parties (« une commande de protection est arrivée après »). BSB-LAN
ne sert qu'une requête à la fois : ils attendent la fin de celle qu'il
traite. S'il est encore occupé au bout de 3,5 s, Gladys répond « la commande
passe en tête et part dès qu'il est libre » et l'envoie dès que possible
(sous 30 s). Si une lecture suivante montre encore l'ancien mode, ils sont
renvoyés (3 fois au plus) ; si elle montre un autre mode (changé sur la
chaudière), ils ne sont pas renvoyés.

Ils sont refusés seulement quand ils ne peuvent pas partir : aucun
adaptateur configuré, bus PPS, autre adaptateur lu à l'adresse (autre
adresse MAC), BSB-LAN injoignable, ou BSB-LAN qui refuse l'écriture
(paramètre en lecture seule : statut 2). Ils ne sont pas gardés dans `/data`
: un redémarrage de l'intégration entre deux renvois les oublie.

BSB-LAN doit aussi autoriser l'écriture sur le bus, et nommer son bus BSB
ou LPB : sinon l'écran de configuration l'indique et les commandes sont
refusées. Pour savoir si l'écriture est permise, l'intégration lit d'abord
l'accès que BSB-LAN donne à **chaque paramètre** dans sa réponse (`readwrite` :
0 lecture/écriture, 1 lecture seule, 2 écriture seule) : il tient compte du
réglage d'écriture de BSB-LAN et des paramètres que le régulateur verrouille.
Faute de cet accès, elle suit le champ `buswritable` de `/JI` (1, 2, « Yes »,
« RW »… : autorisée ; 0, « No », « RO »… : lecture seule ; toute autre valeur :
inconnue, commandes refusées). Jusqu'à la version 5.1.18, BSB-LAN écrit ce
champ de travers (un nombre à virgule affiché comme un entier : il vaut
souvent 0 alors que l'écriture est permise) : il n'est alors jamais cru.

### Plafond de l'eau chaude : 65 °C par défaut

Une eau chaude brûle en quelques secondes. Gladys ne règle donc **jamais
l'eau chaude au-dessus de 65 °C** par défaut. Le réglage **Plafond de l'eau
chaude** l'abaisse, de 40 à 65 °C ; il n'est **jamais possible de dépasser
65 °C**, quoi qu'on saisisse. Le maximum nominal du régulateur (1614), relu
avant chaque commande, s'applique toujours s'il est plus bas.
Une consigne au-dessus du plafond est refusée dès son arrivée, sans être
envoyée ; le plafond est revérifié après la relecture et juste avant l'envoi
(un plafond abaissé pendant une commande l'arrête). Le maximum (1614), la
fonction anti-légionelles et les programmes horaires ne sont jamais
modifiés.

Ce que le plafond ne fait pas :

- **abaisser le plafond ne baisse pas une consigne déjà plus haute** dans
  le régulateur (réglée sur la chaudière, ou avant) : il limite seulement
  ce que Gladys envoie. Baissez-la vous-même si besoin ;
- la **fonction anti-légionelles** du régulateur (1640 à 1648) chauffe
  l'eau à sa propre consigne, parfois au-dessus du plafond :
  Gladys ne la règle pas et ne l'empêche pas.

### Ce que Gladys ne fait jamais

- **Quitter un mode inconnu** du régulateur, sauf vers Protection : la
  commande est refusée, le régulateur garde la main. Dans ce cas la **liste « Mode de chauffage »
  garde le dernier choix connu** (un mode inconnu n'y figure pas) : regardez
  « Mode de chauffage (lu) », qui affiche toujours le mode réel.
- Proposer un interrupteur : le mode est une **liste**, les consignes sont
  des thermostats ; un « éteins tout » (Gladys, Google Home, Alexa, HomeKit)
  ne touche pas le chauffage. Une scène peut changer le mode ou une
  consigne, seulement par une action explicite et si les commandes sont
  autorisées. Attention : le chat IA de Gladys (MCP) peut créer et lancer
  une telle scène.

### Comment une commande part

Avant chaque commande (sauf Protection et eau chaude à l'arrêt), l'intégration relit d'abord l'adaptateur (`/JI`) :
il doit avoir la même adresse MAC que l'appareil et un bus BSB ou LPB, et
la relecture doit donner le paramètre en écriture, sinon rien n'est envoyé (un autre adaptateur qui a
pris l'adresse IP n'est jamais commandé). Puis elle **relit** la valeur
actuelle et la plage permise par le régulateur, et décide sur cette lecture
seule ; aucune
autre requête ne passe entre cette relecture et l'écriture, et l'option (et
le plafond) est revérifiée juste avant l'envoi. Si une valeur ou la plage
manque, la commande est refusée. Une valeur déjà en place n'est pas
renvoyée. Une commande qui ne peut pas partir dans les 3,5 secondes est
refusée sans être envoyée ; Gladys reçoit la réponse dans ses 5 secondes.
BSB-LAN accepte une écriture par un statut 1 ; l'intégration **relit alors
le paramètre** et n'annonce un succès que si la relecture montre la valeur
demandée (encore l'ancienne : « relue juste après, encore la précédente » ;
pas relue à temps : « envoyée, sans confirmation »). Un statut 2 (paramètre en
lecture seule) donne « BSB-LAN a refusé la commande » ; sans confirmation
claire (silence, connexion coupée, erreur 5xx, statut 0), Gladys affiche
« Commande envoyée, sans confirmation » : vérifiez la valeur, relue 5 puis
20 secondes plus tard. Une commande à la fois, et 3 secondes au moins entre
deux écritures (sinon « encore en cours »).

## Erreurs et limites

- **BSB-LAN injoignable** : « Mode de chauffage (lu) » affiche « BSB-LAN
  injoignable », l'appareil passe en injoignable, les autres valeurs gardent
  leur dernière valeur. Nouvel essai après 30 s, 1, 2 puis 5 minutes, jamais
  plus vite que l'intervalle.
- **Identifiants refusés** (HTTP 401 ou 403) : l'intégration s'arrête et le
  dit ; nouveaux essais après 15 min, 1 h, 6 h puis toutes les 24 h, jamais
  en boucle, même après un redémarrage (l'arrêt est gardé dans `/data`).
  Enregistrer d'autres identifiants ou appuyer sur « Tester la connexion »
  réessaie tout de suite.
- **BSB-LAN occupé ou en erreur** (HTTP 429 ou 5xx) : pause de 1 minute à
  6 heures (selon `Retry-After`), gardée dans `/data`, pour les lectures
  comme pour les commandes.
- **Passkey fausse, ou IP de Gladys absente des adresses de confiance** :
  d'après la source du micrologiciel, BSB-LAN ferme alors la connexion sans
  rien répondre (jamais de 404). L'intégration ne peut pas le distinguer
  d'un adaptateur injoignable : le statut « injoignable » le rappelle.
  Vérifiez la passkey et, si BSB-LAN limite les adresses autorisées, ajoutez
  celle de Gladys.
- **Micrologiciel trop ancien** (sans `/JV`) : non pris en charge, comme
  python-bsblan ; nouvel essai toutes les 30 minutes.
- **Régulateur en °F** : ses températures ne sont pas affichées (les
  fonctionnalités sont en °C).
- **Un seul adaptateur** par intégration, **circuits de chauffage 1 et 2**.
- Pas encore : rafraîchissement, programmes horaires, commandes sur bus PPS,
  circuit 3.
- Les journaux ne contiennent jamais la clé de passe, l'identifiant, le mot
  de passe ni les réponses de BSB-LAN ; `/data` ne garde que la pause et
  l'arrêt, jamais un secret.

## Crédits

Portage de [python-bsblan](https://github.com/liudger/python-bsblan)
(Willem-Jan L. van Rootselaar et contributeurs, MIT, version 6.1.10), la
bibliothèque de l'intégration BSB-LAN de Home Assistant. Licence Apache-2.0.
