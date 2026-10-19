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
  de BSB-LAN.

## Ce que vous obtenez

Un appareil « Chauffage (BSB-LAN) » par adaptateur, reconnu par son adresse
MAC (il reste le même si l'adresse IP change). Chaque fonctionnalité
n'apparaît que si le régulateur en donne la valeur :

| Fonctionnalité                   | Paramètre | Contenu                                               |
| -------------------------------- | --------- | ----------------------------------------------------- |
| Mode de chauffage                | 700       | Liste (commandes autorisées seulement), voir plus bas |
| Mode de chauffage (lu)           | 700       | Texte : le mode réel, y compris un mode inconnu       |
| État du circuit de chauffage     | 8000      | Texte du régulateur (« Chauffage confort »…)          |
| Consigne confort                 | 710       | Thermostat, circuit 1, en °C (commande)               |
| Consigne réduite                 | 712       | En °C, lecture seule                                  |
| Température de la pièce          | 8740      | En °C                                                 |
| Température extérieure           | 8700      | En °C                                                 |
| Mode de l'eau chaude             | 1600      | Texte : arrêt, marche, éco                            |
| Consigne d'eau chaude            | 1610      | Chauffe-eau, en °C (commande, plafonnée)              |
| Consigne réduite de l'eau chaude | 1612      | En °C, lecture seule                                  |
| Température de l'eau chaude      | 8830      | En °C                                                 |
| Pompe d'eau chaude en marche     | 8820      | 0 ou 1                                                |
| Énergie apportée (kWh)           | 3113      | En kWh, simple valeur (voir plus bas)                 |

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
est refusée. Activée, Gladys peut changer :

- le **mode de chauffage** du circuit 1 : automatique (programme horaire),
  confort, réduit, protection (hors-gel) ;
- la **consigne confort** du circuit 1, au dixième de degré, jamais sous la
  consigne réduite (712) ni la consigne de protection (714), jamais
  au-dessus de la consigne confort maximale (716) que le régulateur donne,
  et toujours entre 5 et 35 °C ;
- la **consigne d'eau chaude** (1610), en degrés entiers, entre la consigne
  réduite (1612) et le maximum du régulateur (1614), jusqu'au **plafond**.

BSB-LAN doit aussi autoriser l'écriture sur le bus, et nommer son bus BSB
ou LPB : sinon l'écran de configuration l'indique et les commandes sont
refusées. L'écriture n'est tenue pour autorisée que si BSB-LAN ne dit rien
(anciens micrologiciels) ou dit exactement 1.

### Plafond de l'eau chaude : 55 °C par défaut

Une eau à 60 °C brûle en quelques secondes. Gladys ne règle donc **jamais
l'eau chaude au-dessus de 55 °C** par défaut. Le réglage **Plafond de l'eau
chaude** le change de 40 à 60 °C ; il n'est **jamais possible de dépasser
60 °C**, quoi qu'on saisisse (même si le régulateur accepte souvent 65 °C).
Une consigne au-dessus du plafond est refusée dès son arrivée, sans être
envoyée ; le plafond est revérifié après la relecture et juste avant l'envoi
(un plafond abaissé pendant une commande l'arrête). Les consignes réduites,
la fonction anti-légionelles et les programmes horaires ne sont jamais
modifiés.

Ce que le plafond ne fait pas :

- **abaisser le plafond ne baisse pas une consigne déjà plus haute** dans
  le régulateur (réglée sur la chaudière, ou avant) : il limite seulement
  ce que Gladys envoie. Baissez-la vous-même si besoin ;
- la **fonction anti-légionelles** du régulateur (1640 à 1648) chauffe
  l'eau à sa propre consigne, souvent 60 °C ou plus, au-dessus du plafond :
  Gladys ne la règle pas et ne l'empêche pas.

### Ce que Gladys ne fait jamais

- **Quitter un mode inconnu** du régulateur : la commande est refusée, le
  régulateur garde la main. Dans ce cas la **liste « Mode de chauffage »
  garde le dernier choix connu** (un mode inconnu n'y figure pas) : regardez
  « Mode de chauffage (lu) », qui affiche toujours le mode réel.
- Proposer un interrupteur : le mode est une **liste**, les consignes sont
  des thermostats ; un « éteins tout » (Gladys, Google Home, Alexa, HomeKit)
  ne touche pas le chauffage. Une scène peut changer le mode ou une
  consigne, seulement par une action explicite et si les commandes sont
  autorisées. Attention : le chat IA de Gladys (MCP) peut créer et lancer
  une telle scène.

### Comment une commande part

Avant chaque commande, l'intégration relit d'abord l'adaptateur (`/JI`) :
il doit avoir la même adresse MAC que l'appareil, un bus BSB ou LPB et
l'écriture autorisée, sinon rien n'est envoyé (un autre adaptateur qui a
pris l'adresse IP n'est jamais commandé). Puis elle **relit** la valeur
actuelle et la plage permise par le régulateur, et décide sur cette lecture
seule ; aucune
autre requête ne passe entre cette relecture et l'écriture, et l'option (et
le plafond) est revérifiée juste avant l'envoi. Si une valeur ou la plage
manque, la commande est refusée. Une valeur déjà en place n'est pas
renvoyée. Une commande qui ne peut pas partir dans les 3,5 secondes est
refusée sans être envoyée ; Gladys reçoit la réponse dans ses 5 secondes.
BSB-LAN confirme une écriture par un statut 1 ; un statut 2 (paramètre en
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
  dit (un 403 peut aussi venir de l'adresse IP de Gladys absente des
  adresses de confiance de BSB-LAN) ; nouveaux essais après 15 min, 1 h, 6 h puis toutes les 24 h, jamais
  en boucle, même après un redémarrage (l'arrêt est gardé dans `/data`).
  Enregistrer d'autres identifiants ou appuyer sur « Tester la connexion »
  réessaie tout de suite.
- **BSB-LAN occupé ou en erreur** (HTTP 429 ou 5xx) : pause de 1 minute à
  6 heures (selon `Retry-After`), gardée dans `/data`, pour les lectures
  comme pour les commandes.
- **Clé de passe fausse** : BSB-LAN devrait répondre « introuvable » (HTTP
  404), et l'écran de configuration le dit alors ; **à vérifier** sur un
  vrai adaptateur (il peut aussi répondre autrement : la lecture échoue
  alors comme un adaptateur injoignable).
- **Micrologiciel trop ancien** (sans `/JV`) : non pris en charge, comme
  python-bsblan ; nouvel essai toutes les 30 minutes.
- **Régulateur en °F** : ses températures ne sont pas affichées (les
  fonctionnalités sont en °C).
- **Un seul adaptateur** par intégration, **circuit de chauffage 1**
  seulement.
- Pas encore : circuit 2, rafraîchissement, programmes horaires, commandes
  sur bus PPS, mode de l'eau chaude en commande.
- Les journaux ne contiennent jamais la clé de passe, l'identifiant, le mot
  de passe ni les réponses de BSB-LAN ; `/data` ne garde que la pause et
  l'arrêt, jamais un secret.

## Crédits

Portage de [python-bsblan](https://github.com/liudger/python-bsblan)
(Willem-Jan L. van Rootselaar et contributeurs, MIT, version 6.1.10), la
bibliothèque de l'intégration BSB-LAN de Home Assistant. Licence Apache-2.0.
