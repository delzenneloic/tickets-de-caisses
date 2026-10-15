# Tickets de caisse

Application web installable pour photographier ou importer des tickets, puis les enregistrer directement sur Google Drive.

```text
tickets de caisses/
├── enseignes.json
└── 2026.09/
    └── A traiter/
        └── 000042.2026.09.12.091530.398.jpg
```

- Photos et PDF, jusqu’à 25 Mo par fichier.
- Date et heure locale du premier envoi, avec les millisecondes.
- Dossiers mensuels créés automatiquement.
- Sous-dossier **A traiter** dans chaque mois.
- Enseigne obligatoire : recherche par sous-chaîne, création avec nom, adresse et TVA.
- Répertoire des enseignes partagé via Drive ; identifiant entier de 1 à 999999, préfixé sur six chiffres dans les noms des tickets.
- Conservation locale des tickets en attente et reprise des envois interrompus.
- Accès Google limité à la portée `drive.file` ; aucun serveur de stockage intermédiaire.

## Utilisation

Ouvrir l’application, connecter Google Drive, sélectionner une enseigne (ou choisir **Nouvelle enseigne**), ajouter les tickets de cette enseigne, puis choisir **Envoyer vers Drive**. La saisie libre seule ne valide pas une enseigne : il faut sélectionner une proposition ou créer une fiche. Le navigateur peut proposer de l’installer sur l’écran d’accueil.

## Hébergement

Les fichiers sont statiques et ne nécessitent aucune compilation. Ils peuvent être publiés avec GitHub Pages, depuis la racine du dépôt.

L’origine HTTPS du site doit être autorisée dans le client Google OAuth configuré au début de `app.js`. Cet identifiant client est public ; aucun secret client ne doit être ajouté au dépôt.

Le [guide de mise en place](./LIRE-MOI.md) détaille la configuration Google, le classement et la conservation des tickets.

## Analyse fonctionnelle et tests

Le [dossier fonctionnel](./docs/analyse-fonctionnelle.md) décrit les règles, le modèle UML, le processus et la matrice de recette.

- `npm test` : 14 tests automatisés du métier et de l’intégration Drive simulée, sans dépendance.
- `npm install`, puis `npx playwright install chromium` et `npm run test:browser` : 6 parcours dans un navigateur avec Google simulé. Un navigateur déjà installé peut être utilisé avec la variable `BROWSER_CHANNEL=msedge` ou `chrome`.
- Aucune compilation ou dépendance n’est nécessaire pour héberger l’application ; Playwright sert uniquement aux tests.

Validation locale du 15 octobre 2026 : tests unitaires et parcours navigateur réussis. La connexion OAuth, les droits Drive et les écritures conditionnelles restent à vérifier avec le compte Google réel pour compléter ces tests automatisés.
