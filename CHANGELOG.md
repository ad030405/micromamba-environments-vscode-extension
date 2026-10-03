# Changelog

## 1.0.0

- Set the Marketplace release version to 1.0.0 and update package references in the installation and publishing guides.

## 0.1.4

- Set the author and intended Marketplace publisher to ad070809; update extension ID references in documentation and integration fixtures.
- Add instructions for creating a publisher, uploading the VSIX, and migrating from the development extension ID.

## 0.1.3

- Localize sidebar titles, toolbar and context menu commands, welcome links, extension descriptions, and settings with package.nls resources.
- Localize environment status labels, tooltips, prompts, confirmations, progress, validation, and diagnostic messages with the VS Code l10n API.
- Show Chinese for zh-cn / zh-tw and use English as the fallback for other IDE languages, without combined Chinese / English labels.

## 0.1.2

- Reuse environment identities and synchronize Python only after the official selection transaction commits.
- Resolve resource-less Python validation from the active project's saved environment.
- Localize the run command: Chinese for zh-cn / zh-tw, English fallback for other IDE languages.
- Make terminal activation silent by default using scoped environment variable collections before process creation; retain optional shell-command activation.
- Add first-selection, identity and terminal-scope regression coverage, plus fresh-project integration and diagnostic-log checks.

## 0.1.1

- Show only the icon and Micromamba name for the official environment manager; move its description into a tooltip.
- Remove the extra status bar interpreter picker; use the official Python picker or environment sidebar.
- Move the Micromamba run command into the existing editor Run dropdown instead of adding a separate button.

## 0.1.0

- Add micromamba environment and package sidebar.
- Register providers with Microsoft Python Environments.
- Select project interpreters, activate terminals, run files and configure launch debugging.
- Create, import, export and delete environments; manage Conda and pip packages.
