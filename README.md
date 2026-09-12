# Tickets de caisse

Application web installable pour photographier ou importer des tickets, puis les enregistrer directement sur Google Drive.

```text
tickets de caisses/
└── 2026.09/
    └── 2026.09.12.091530.398.jpg
```

- Photos et PDF, jusqu’à 25 Mo par fichier.
- Date et heure locale du premier envoi, avec les millisecondes.
- Dossiers mensuels créés automatiquement.
- Conservation locale des tickets en attente et reprise des envois interrompus.
- Accès Google limité à la portée `drive.file` ; aucun serveur de stockage intermédiaire.

## Utilisation

Ouvrir l’application, connecter Google Drive, ajouter les tickets, puis choisir **Envoyer vers Drive**. Le navigateur peut proposer de l’installer sur l’écran d’accueil.

## Hébergement

Les fichiers sont statiques et ne nécessitent aucune compilation. Ils peuvent être publiés avec GitHub Pages, depuis la racine du dépôt.

L’origine HTTPS du site doit être autorisée dans le client Google OAuth configuré au début de `app.js`. Cet identifiant client est public ; aucun secret client ne doit être ajouté au dépôt.

Le [guide de mise en place](./LIRE-MOI.md) détaille la configuration Google, le classement et la conservation des tickets.
