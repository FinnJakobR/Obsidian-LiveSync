# CFRDT Sync System für Obsidian

Dieses Repository bzw. Plugin basiert auf einem **Conflict-free Replicated Data Type (CRDT)** Ansatz und dient dazu, meine Obsidian-Daten zwischen verschiedenen Geräten zu synchronisieren.

## Zweck

Ich nutze dieses System, um meine Obsidian-Vaults zwischen mehreren Geräten zu synchronisieren, ohne auf kostenpflichtige Dienste wie Obsidian Sync angewiesen zu sein.

Hoste tue ich dieses System auf einem persönlichen Raspberrypi

## Funktionsweise
Das System basiert auf einem CRDT-Ansatz, wodurch Konflikte automatisch aufgelöst werden können.
Es ist für einen einzelnen Benutzer optimiert.
Änderungen werden auf einem Gerät vorgenommen und dann mit anderen Geräten synchronisiert.
Ziel ist es, möglichst konsistente Daten ohne manuelle Konfliktlösung zu erhalten.