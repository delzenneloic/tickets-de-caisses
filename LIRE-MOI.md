# Tickets de caisse

Une petite application web installable sur téléphone, dans le même esprit que votre suivi musculation. Elle envoie directement les photos et les PDF vers votre Google Drive.

## Mise en place

1. Décompressez l’archive et placez tout le dossier `tickets-de-caisses` sur votre hébergement web, comme l’application Muscu. Gardez les fichiers ensemble et utilisez un dossier distinct, par exemple `https://votre-domaine/tickets-de-caisses/`.
2. Ouvrez cette adresse dans votre navigateur. Un double-clic sur `index.html` ne permet pas la connexion Google : il faut une adresse HTTPS, ou `http://localhost` pour les essais sur ordinateur.
3. Cliquez sur **Connecter Google Drive** et choisissez votre compte. Le client Google public de votre application Muscu est déjà renseigné dans `app.js`.
4. Ajoutez un ticket avec **Photographier** ou **Importer des fichiers**, puis cliquez sur **Envoyer vers Drive**. La connexion seule n’envoie aucun fichier.
5. Sur téléphone, ajoutez le site à l’écran d’accueil depuis le menu du navigateur pour l’utiliser comme une application.

## Si Google refuse la connexion

Si vous hébergez cette application sous la même origine web que Muscu (mêmes protocole, domaine et port), le client existant peut être réutilisé. Le chemin du sous-dossier ne fait pas partie de l’origine.

Pour une nouvelle origine, ouvrez le projet correspondant dans la [console Google Cloud](https://console.cloud.google.com/apis/credentials), éditez le client OAuth web utilisé dans `app.js`, et ajoutez cette origine dans **Origines JavaScript autorisées**. Exemple : `https://votre-domaine`, sans `/tickets-de-caisses/`. Attendez la prise en compte puis rechargez l’application.

Pour un essai local, autorisez `http://localhost` et `http://localhost:8080`, puis servez le dossier sur ce port. Vérifiez également que **Google Drive API** est activée dans le projet et que votre compte fait partie des utilisateurs de test si le consentement est encore en mode test. Aucun secret client et aucune clé API ne sont nécessaires dans ces fichiers.

Vous pouvez aussi utiliser un autre client OAuth web en remplaçant uniquement `CLIENT_ID` au début de `app.js`.

[Configuration officielle Google](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid) · [Connexion et expiration de session](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

## Classement et noms

Exemple d’un ticket envoyé le 12 septembre 2026 à 09:15:30.398 :

```text
Mon Drive/
└── tickets de caisses/
    └── 2026.09/
        └── 2026.09.12.091530.398.jpg
```

- Le dossier principal porte exactement le nom demandé : **tickets de caisses**.
- Le sous-dossier suit le format **yyyy.MM**.
- Le nom suit **yyyy.MM.dd.HHmmss.kkk**, où `kkk` désigne les millisecondes sur trois chiffres, puis l’extension du fichier. Dans de nombreuses bibliothèques ce dernier composant est appelé `SSS` ; le résultat demandé est identique.
- La date et l’heure proviennent du fuseau horaire de l’appareil au début du premier envoi du ticket, et non de la prise de vue. Le dossier du mois utilise la même date.
- En cas d’envois au même instant, la milliseconde est différenciée dans le lot.
- Une nouvelle tentative garde le nom, le mois, le compte et l’identifiant Drive du premier envoi.
- Un fichier importé correspond à un ticket. Un PDF de plusieurs pages reste un seul PDF. Les fichiers ne sont pas fusionnés, recadrés ni compressés.
- Formats : JPG/JPEG, PNG, WebP, HEIC/HEIF, AVIF, GIF, TIFF et PDF, jusqu’à 25 Mo par fichier. L’affichage de certains formats dépend du navigateur ; leur envoi conserve le fichier original.

Les dossiers existants sont réutilisés lorsqu’ils sont accessibles à cette application. Avec l’autorisation limitée `drive.file`, un dossier créé manuellement ou par une autre application peut être invisible : l’application crée alors son propre dossier du même nom. Elle n’a pas accès à tout votre Drive. Évitez de créer le dossier manuellement avant le premier envoi.

## Conservation et reprises

Les tickets en attente sont enregistrés dans le stockage local du navigateur (IndexedDB), y compris après fermeture et réouverture de l’application. L’app demande au navigateur de préserver ce stockage, mais cela reste une copie temporaire : effacer les données du site, désinstaller certains navigateurs ou manquer d’espace peut les supprimer. La confirmation **Enregistré** signifie que Google Drive a confirmé le fichier.

L’envoi se fait par blocs de 1 Mo. Après une interruption, reconnectez Google si nécessaire puis relancez **Envoyer vers Drive**. Une session encore valide reprend à l’endroit confirmé par Drive ; une session expirée peut recommencer le transfert. Un identifiant Drive fixé avant la création évite les doublons lorsque la réponse de confirmation s’est perdue. Gardez l’application ouverte pendant l’envoi : elle ne transfère pas les fichiers en arrière-plan une fois fermée.

Après confirmation, la copie locale du fichier est libérée et seules les informations de l’envoi restent dans l’historique. L’historique est propre à cet appareil et filtré par compte ; le dossier Drive contient les fichiers envoyés depuis tous vos appareils. Les tickets dont un envoi a commencé restent liés au compte initial.

Les accès Google restent uniquement en mémoire et ne sont pas enregistrés sur le disque. Il faut donc se reconnecter après une fermeture ou une expiration de session. Le bouton **Drive connecté** déconnecte l’application sur cet appareil. Il ne retire pas les autorisations accordées dans votre compte Google et ne déconnecte pas votre compte des autres sites.

[Envoi et reprise : documentation Google Drive](https://developers.google.com/workspace/drive/api/guides/manage-uploads) · [Identifiants et prévention des doublons](https://developers.google.com/workspace/drive/api/guides/create-file) · [Portée des autorisations](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

## Fichiers et mises à jour

L’application fonctionne sans dépendance à installer : `index.html`, `style.css`, `app.js`, `core.js`, `manifest.json`, `sw.js` et les trois icônes. Le guide peut être laissé à côté des fichiers.

Lors d’une modification du code, augmentez le suffixe de version de `CACHE` dans `sw.js` (par exemple `v1` vers `v2`) puis remplacez les fichiers sur votre hébergement. Fermez toutes les fenêtres de l’application puis rouvrez-la pour activer la mise à jour. Le cache de cette application est isolé par chemin et ne supprime pas celui de Muscu.

## Vérification

Le format des noms, le classement Drive et les scénarios d’envoi/reprise sont vérifiés avec des réponses Google simulées. La connexion et l’envoi réels doivent être essayés depuis votre adresse autorisée avec votre compte Google ; aucun accès à votre compte ni aucun envoi réel n’a été effectué lors de la création.
