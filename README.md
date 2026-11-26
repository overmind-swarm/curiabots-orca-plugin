# CuriaBots plugin for Orca

**English** · [Español](#español)

Connects [Orca](https://orca.dev) to a [CuriaBots](https://curiabots.com) agent. Once linked, you can ask your agent (in plain language) to send an issue to Orca, ask what is running, answer questions of the Orca agent, or stop a job, and CuriaBots tells you when Orca needs something or a turn ends.

The plugin only makes **outgoing** connections (WSS over 443) to the CuriaBots *Orca* skill. No ports to open, no Tailscale. Your Orca and GitHub credentials never leave your computer.

## Requirements

- Orca **1.4.259 or newer** (desktop app). Plugins must be turned on (Settings → Plugins).
- A CuriaBots agent with the **Orca** skill added from the app store.
- An OS key store, so the link token is stored encrypted (see [Where the token lives](#where-the-token-lives)).
- Optional: the Orca CLI, only to reply to an agent (`send`).

## Install

```sh
orca plugin install overmind-swarm/curiabots-orca-plugin
```

Orca installs the newest `vX.Y.Z` tag and shows the permissions the plugin asks for. Approve them to enable it. The plugin key is `overmind-swarm.curiabots`. To update: `orca plugin update overmind-swarm.curiabots`; to remove it: `orca plugin uninstall overmind-swarm.curiabots` (or Settings → Plugins).

### Permissions, and why

| Permission | Why |
|---|---|
| `workspace:read` | List your projects (to choose which ones a link may use) and hear when a workspace is created or removed (to keep the list current in *Allow all projects* mode). |
| `workspace:create` | Create the git worktree for a job, only in projects you allowed (or, if you turn on *Allow all projects*, in projects Orca lists). |
| `agent:launch` | Start the agent (Claude Code, Codex...) in that worktree with the instruction. |
| `agent:read` | Hear when the agent starts working, waits for you or finishes. |
| `terminal:read` | Read a bounded excerpt of the job's terminal output to include in notices and `read_output`. |
| `terminal:send` | Close a job's terminal (`stop`). Replies use the Orca CLI instead, because the plugin API cannot type into terminals outside the active worktree. |
| `secrets:own` | Keep the link token in Orca's encrypted file for this plugin. |
| `storage:own` | Keep the installation id, links, jobs and the outbox of pending notices. |
| `settings:own` | Read the plugin settings. |

It does **not** ask for automations or session history, and it never receives shell commands from the cloud: it only understands five commands (`start_job`, `get_job`, `read_output`, `send`, `stop`).

## Link an agent

1. In CuriaBots open the **Orca** skill of your agent and choose **Link an Orca**. You get a one-time code that expires in 10 minutes.
2. In Orca open the **CuriaBots** panel (right sidebar), paste the code, optionally name this computer, and press **Link**.
3. Under **Allowed projects** tick the projects this link may work in. Nothing is allowed by default: a link with no projects cannot start jobs, and while that is so the section is open with a warning and a **Choose projects** button. The decision is made here, on your machine. Once projects are chosen the section can be folded; its title still says how many and which (or *All*).

The card shows the agent's name as its title and, if the service sends one, the name you gave the link in CuriaBots.

You can link several agents to the same Orca (each link has its own token, projects and connection and sees only its own jobs) and one agent to several Orcas. The status bar shows `CuriaBots: online`, `linked`, `offline` or `unlinked`.

### Allow all projects

Each link has a switch, **Allow all projects**, **off by default**. Turn it on and the agent can start work in **any** Git project Orca lists (local and SSH), including projects you add later, instead of only the ticked ones. The panel warns when you turn it on: the agent can launch work in any project of this Orca, including repos with access to production.

- Folders that are not Git projects, and projects you **hid** in Orca, are not included (hiding is your own "I do not work here"). A hidden project can still be allowed by ticking it in the explicit list.
- The service gets the list in `hello` and in `projects`, as with the explicit list.
- **Keeping the list current:** the plugin re-reads Orca's project list when a workspace is created or removed and every 60 seconds (a project added without any workspace raises no event), and sends a new `projects` message only if the list changed. `start_job` additionally checks the project against Orca's live list at that moment, so a stale announcement never widens what can be started, and a project that is not in `project.list` (a path, a folder, a hidden one, another host's id) is always refused. If Orca cannot list projects, `start_job` fails with `orca_unavailable` and the last announced list is kept.
- Turning it off goes back to your explicit list, which is kept untouched. Links made with 0.1.x load with it off.

## Unlink

Press **Unlink** (twice, to confirm) in the panel. The token is deleted, the skill is told, and the agents already running in Orca are left alone. Other links are not affected. If you unlink from CuriaBots instead, the link shows as *revoked* and you can remove it.

## Where the token lives

- With an OS key store (`os-keyring`) the token is kept in Orca's encrypted secrets, always.
- **Without one** (typical for `orca serve` on a server with no desktop: Linux without gnome-keyring/libsecret or KWallet) the panel **refuses to link** and explains how to enable a keyring. Install and unlock one, then restart Orca.
- Notices waiting for the service's acknowledgement (an outbox of at most 500 per link, with the last lines of agent output) sit in the plugin's private storage until acknowledged.
- Advanced and at your own risk: the setting **Allow token without keyring** stores the token in the plugin's plain private storage instead. The panel and the status bar then show a permanent warning *token stored without a keyring*.

## Settings

| Setting | Default | |
|---|---|---|
| Service URL | `https://api.curiabots.com/skills/orca` | Only change it to test another server. https only (http for `localhost`). Applies to links made afterwards. |
| Orca CLI path | empty | Absolute path of the Orca CLI. Empty = detect. On Linux the `orca` in `PATH` may be the GNOME screen reader, so the plugin first tries `~/.config/orca/linux-orca-cli-shim/orca` and accepts a candidate only if `status --json` answers like Orca. |
| Allow token without keyring | off | See above. |

## How jobs work

- `start_job` creates a worktree in an allowed project (the ticked ones, or any listed project with *Allow all projects*) and starts the agent with the instruction. It is idempotent per job id and never creates a second worktree for the same id.
- Status changes are reported after they hold for 5 seconds, with the last lines of output (at most 4 KiB). Notices wait in a local outbox, survive restarts and are resent until the service acknowledges them.
- `send` (answering an agent) is accepted only if the agent is waiting for input or finished its turn (never on a permission prompt: those you resolve in Orca) and the Orca CLI confirms the terminal is still running that agent.
- Limits: 5 active jobs per link and 10 in total, whatever the service asks.
- Agents you open by hand in Orca are never shown to CuriaBots.

## Diagnostics

```sh
orca plugin logs overmind-swarm.curiabots
```

Logs contain identifiers, sizes and states only: never the token, the code, the instruction or the agent output. Typical lines: `online`, `closed close_code=...`, `reconnect.scheduled`, `start_job.rejected reason=project_not_allowed`, `send.refused`.

- *Offline, retrying*: the plugin reconnects with growing delays (1 s up to 5 min). Check your network.
- *Token rejected*: the link was revoked on the service side. Unlink and link again.
- *Plugin too old*: update it.

## What a notice contains

The `excerpt` of a `job.status` notice (and of `get_job`) is only the agent's last relevant output, text of at most 40 lines and 4 KiB, not the whole terminal:

- Control sequences, the agent's banner (Claude Code, Codex), box borders, spinners, timers and token counters (`✻ Cooked for 9s`), footers and hints (`⏵⏵ bypass permissions on`, `100% context left`) are removed.
- Everything up to the last prompt echo (the prompt we sent) is cut, and so is the empty or placeholder prompt box at the end.
- Of the agent's output blocks, the last text block is kept; tool calls and their results are dropped. If the screen ends in a question with options or a permission dialog, the last block is kept whole so the user sees what is asked.
- A notice is not repeated when the state and the excerpt are the same once durations, counters, clock times and spinner glyphs are ignored. A change of state is always reported.

`read_output` is unchanged: it returns the raw lines.

When the agent shows a numbered selector (Claude Code's question and permission prompts: `1. Yes / 2. No / 3. Type something`), a `waiting_user` notice (and `get_job`) also carries `options: [{n, label}]` (n from 1 to 9, label up to 120 characters). A change of options counts as news for the dedupe.

### Replying: `send`

`send` takes exactly one of `text` (with `enter`) or `option` (an integer 1 to 9). An `option` types only that digit, with no Enter, which picks that option in a selector. Typing text into a selector is not reliable, so when the Orca CLI refuses with `agent_prompt_blocked` the plugin does not retry: it answers `needs_option` with `details.options` (the options detected on screen, possibly empty). Any other CLI failure is mapped to a code of the contract (`not_found`, `forbidden`, `invalid_args`, `timeout`, `orca_unavailable`) with a message that says what happened; the CLI's own code goes to the log as `error_code`.

Upgrading from 0.2.x: the dedupe hash stored with a running job was computed without normalizing, so each such job may send one repeated notice, once.

## Tested platforms

| Platform | State |
|---|---|
| Linux (Ubuntu, GNOME), Orca 1.4.267 desktop | Tested, including a real agent launched, answered and stopped |
| macOS (Keychain) | Expected to work, **to be validated** |
| Windows (DPAPI) | Expected to work, **to be validated**; replying (`send`) needs a CLI path that `execFile` can run |
| `orca serve` without desktop | **To be validated**; needs a key store or the opt-in above |

## Limitations

- The agent's model cannot be chosen from the cloud yet: the host API has no model parameter, so the agent uses its own default.
- A job runs on the Orca that holds the project; if that computer is off, nothing runs.
- Replies and excerpts are text only.

## Development

No dependencies. Orca CLI required for the full suite:

```sh
orca plugin validate .
orca plugin test .                      # everything, including panel and worker tests
orca plugin check .                     # renders the panel against a mock host
npx -p typescript tsc -p .              # types (`orca plugin types .` first)
node --test test/*.test.ts              # connector tests only; what CI runs
```

`orca plugin dev load .` loads it into your Orca (Orca asks you to approve the permissions).

### Releases

Versions are tags `vX.Y.Z` (Orca installs the newest). To release: bump `version` in `orca-plugin.json` and `src/version.ts` in a PR, merge it, then run the **Release** workflow from `main` (Actions → Release → Run workflow). It validates and creates the tag and the GitHub release.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Overmind Swarm.

---

## Español

Conecta [Orca](https://orca.dev) con un agente de [CuriaBots](https://curiabots.com). Una vez vinculado, puedes pedirle a tu agente en lenguaje natural que mande una issue a Orca, que te diga qué hay en marcha, que responda a una pregunta del agente de Orca o que pare un trabajo. CuriaBots te avisa cuando Orca necesita algo o termina un turno.

El plugin solo abre conexiones **salientes** (WSS por 443) hacia la skill *Orca* de CuriaBots. No hay que abrir puertos ni usar Tailscale. Las credenciales de Orca y de GitHub no salen de tu ordenador.

### Requisitos

- Orca **1.4.259 o superior** (aplicación de escritorio), con los plugins activados (Ajustes → Plugins).
- Un agente de CuriaBots con la skill **Orca** añadida desde la tienda de apps.
- Un almacén de claves del sistema, para guardar cifrado el token (ver [Dónde se guarda el token](#dónde-se-guarda-el-token)).
- Opcional: la CLI de Orca, solo para responder a un agente (`send`).

### Instalación

```sh
orca plugin install overmind-swarm/curiabots-orca-plugin
```

Orca instala el tag `vX.Y.Z` más reciente y te enseña los permisos que pide el plugin; apruébalos para activarlo. La clave del plugin es `overmind-swarm.curiabots`. Para actualizar: `orca plugin update overmind-swarm.curiabots`; para quitarlo: `orca plugin uninstall overmind-swarm.curiabots` (o Ajustes → Plugins).

#### Permisos y para qué

| Permiso | Para qué |
|---|---|
| `workspace:read` | Listar tus proyectos (para elegir cuáles puede usar una vinculación) y enterarse de que se crea o se borra un workspace (para mantener la lista al día en el modo *Permitir todos los proyectos*). |
| `workspace:create` | Crear el worktree de un job, solo en los proyectos que permitiste (o, si activas *Permitir todos los proyectos*, en los que Orca lista). |
| `agent:launch` | Arrancar el agente (Claude Code, Codex...) en ese worktree con la instrucción. |
| `agent:read` | Saber cuándo el agente trabaja, espera o termina. |
| `terminal:read` | Leer un extracto acotado de la salida de la terminal del job para los avisos y `read_output`. |
| `terminal:send` | Cerrar la terminal de un job (`stop`). Las respuestas usan la CLI de Orca porque la API del plugin no puede escribir en terminales fuera del worktree activo. |
| `secrets:own` | Guardar el token de vinculación en el fichero cifrado de Orca para este plugin. |
| `storage:own` | Guardar el identificador de instalación, las vinculaciones, los jobs y la cola de avisos pendientes. |
| `settings:own` | Leer los ajustes del plugin. |

**No** pide automatizaciones ni historial de sesiones, y nunca recibe comandos de shell desde la nube: solo entiende cinco comandos (`start_job`, `get_job`, `read_output`, `send`, `stop`).

### Vincular un agente

1. En CuriaBots abre la skill **Orca** de tu agente y elige **Vincular un Orca**. Obtienes un código de un solo uso que caduca en 10 minutos.
2. En Orca abre el panel **CuriaBots** (barra lateral derecha), pega el código, pon un nombre a este ordenador si quieres y pulsa **Vincular**.
3. En **Proyectos permitidos** marca los proyectos en los que puede trabajar esa vinculación. Por defecto no hay ninguno: una vinculación sin proyectos no puede lanzar jobs. La decisión se toma aquí, en tu máquina. Mientras no haya ninguno, la sección aparece desplegada con un aviso y un botón **Elegir proyectos**. Con proyectos elegidos puede plegarse; su título sigue diciendo cuántos y cuáles (o *Todos*).

La tarjeta muestra como título el nombre del agente y, si el servicio lo envía, el nombre que diste a la vinculación en CuriaBots.

Puedes vincular varios agentes al mismo Orca (cada vinculación tiene su token, sus proyectos y su conexión, y solo ve sus propios jobs) y un agente a varios Orca. La barra de estado muestra `CuriaBots: online`, `linked`, `offline` o `unlinked`.

#### Permitir todos los proyectos

Cada vinculación tiene un interruptor, **Permitir todos los proyectos**, **desactivado por defecto**. Al activarlo, el agente puede lanzar trabajo en **cualquier** proyecto Git que liste Orca (local y SSH), incluidos los que añadas después, en vez de solo los marcados. El panel avisa al activarlo: el agente podrá lanzar trabajo en cualquier proyecto de este Orca, incluidos repos con acceso a producción.

- No entran las carpetas que no son proyectos Git ni los proyectos que **ocultaste** en Orca (ocultar es tu forma de decir «aquí no trabajo»). Un proyecto oculto se puede permitir marcándolo en la lista explícita.
- El servicio recibe la lista en `hello` y en `projects`, igual que con la lista explícita.
- **Cómo se mantiene la lista al día:** el plugin relee la lista de proyectos de Orca cuando se crea o se borra un workspace y cada 60 segundos (un proyecto añadido sin workspace no genera evento), y envía un `projects` nuevo solo si la lista cambió. Además `start_job` comprueba el proyecto contra la lista viva de Orca en ese instante, así que un anuncio desfasado nunca amplía lo que se puede lanzar, y un proyecto que no esté en `project.list` (una ruta, una carpeta, uno oculto, el id de otro host) se rechaza siempre. Si Orca no puede listar proyectos, `start_job` falla con `orca_unavailable` y se conserva la última lista anunciada.
- Al desactivarlo se vuelve a tu lista explícita, que se conserva intacta. Las vinculaciones hechas con 0.1.x cargan con él desactivado.

### Desvincular

Pulsa **Desvincular** (dos veces, para confirmar) en el panel. Se borra el token, se avisa a la skill y los agentes que ya corren en Orca se quedan como están. Las demás vinculaciones no se tocan. Si desvinculas desde CuriaBots, la vinculación aparece como *revocada* y puedes quitarla.

### Dónde se guarda el token

- Con almacén de claves (`os-keyring`) el token va siempre a los secretos cifrados de Orca.
- **Sin él** (típico de `orca serve` en un servidor sin escritorio: Linux sin gnome-keyring/libsecret ni KWallet) el panel **se niega a vincular** y explica cómo habilitar un llavero. Instala y desbloquea uno y reinicia Orca.
- Los avisos pendientes de confirmación del servicio (una cola de 500 como máximo por vinculación, con las últimas líneas de salida del agente) permanecen en el almacén privado del plugin hasta que se confirman.
- Avanzado y bajo tu responsabilidad: el ajuste **Allow token without keyring** guarda el token en el almacén privado del plugin, sin cifrar. El panel y la barra de estado muestran entonces un aviso permanente *token stored without a keyring*.

### Ajustes

| Ajuste | Por defecto | |
|---|---|---|
| Service URL | `https://api.curiabots.com/skills/orca` | Solo para probar otro servidor. Solo https (http para `localhost`). Se aplica a las vinculaciones que hagas después. |
| Orca CLI path | vacío | Ruta absoluta de la CLI de Orca. Vacío = detectarla. En Linux el `orca` del `PATH` puede ser el lector de pantalla de GNOME, así que el plugin prueba antes `~/.config/orca/linux-orca-cli-shim/orca` y solo acepta un candidato si `status --json` responde como Orca. |
| Allow token without keyring | desactivado | Ver arriba. |

### Cómo funcionan los jobs

- `start_job` crea un worktree en un proyecto permitido (los marcados, o cualquiera listado con *Permitir todos los proyectos*) y arranca el agente con la instrucción. Es idempotente por id de job y nunca crea un segundo worktree para el mismo id.
- Los cambios de estado se notifican cuando se mantienen 5 segundos, con las últimas líneas de salida (máx. 4 KiB). Los avisos esperan en una cola local, sobreviven a reinicios y se reenvían hasta que el servicio los confirma.
- `send` (responder a un agente) solo se acepta si el agente espera una respuesta o terminó su turno (nunca ante un permiso: esos los resuelves en Orca) y la CLI de Orca confirma que la terminal sigue ejecutando ese agente.
- Límites: 5 jobs activos por vinculación y 10 en total, pida lo que pida el servicio.
- Los agentes que abres a mano en Orca no se muestran nunca a CuriaBots.

### Diagnóstico

```sh
orca plugin logs overmind-swarm.curiabots
```

Los logs contienen solo identificadores, tamaños y estados: nunca el token, el código, la instrucción ni la salida del agente. Líneas típicas: `online`, `closed close_code=...`, `reconnect.scheduled`, `start_job.rejected reason=project_not_allowed`, `send.refused`.

- *Desconectado, reintentando*: el plugin reconecta con esperas crecientes (de 1 s a 5 min). Revisa la red.
- *Token rechazado*: la vinculación se revocó en el servicio. Desvincula y vuelve a vincular.
- *Plugin demasiado antiguo*: actualízalo.

### Qué contiene un aviso

El `excerpt` de un aviso `job.status` (y de `get_job`) es solo la última salida relevante del agente, de hasta 40 líneas y 4 KiB: sin banner, sin el eco del prompt, sin spinners, contadores ni pies de pantalla. Un aviso no se repite si el estado y el excerpt son iguales una vez ignorados duraciones, contadores, horas y spinners.

Si el agente muestra un selector numerado (preguntas y permisos de Claude Code), un aviso `waiting_user` (y `get_job`) incluye `options: [{n, label}]` (n de 1 a 9, label de hasta 120 caracteres); un cambio de opciones cuenta como novedad.

### Responder: `send`

`send` admite exactamente uno de `text` (con `enter`) u `option` (entero de 1 a 9). Una `option` escribe solo ese dígito, sin Enter, y elige esa opción en un selector. Escribir texto en un selector no es fiable: si la CLI de Orca responde `agent_prompt_blocked`, el plugin no reintenta y devuelve `needs_option` con `details.options` (las opciones detectadas, posiblemente vacías). Cualquier otro fallo de la CLI se traduce a un código del contrato con un mensaje útil; el código de la CLI va al log como `error_code`.

## Plataformas probadas

| Plataforma | Estado |
|---|---|
| Linux (Ubuntu, GNOME), Orca 1.4.267 de escritorio | Probado, incluido un agente real lanzado, respondido y parado |
| macOS (Keychain) | Se espera que funcione, **por validar** |
| Windows (DPAPI) | Se espera que funcione, **por validar**; responder (`send`) necesita una ruta de CLI que `execFile` pueda ejecutar |
| `orca serve` sin escritorio | **Por validar**; necesita almacén de claves o el ajuste opcional |

### Limitaciones

- Todavía no se puede elegir el modelo del agente desde la nube: la API del host no tiene parámetro de modelo, así que el agente usa el suyo por defecto.
- El job corre en el Orca que tiene el proyecto; si ese ordenador está apagado, no corre nada.
- Las respuestas y los extractos son solo texto.

### Desarrollo y releases

Ver la sección *Development* y *Releases* arriba. Licencia MIT, ver [LICENSE](LICENSE).
