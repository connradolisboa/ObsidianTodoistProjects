import { App, normalizePath, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TFile } from 'obsidian';
import * as os from 'os';

/** Minimal representation of a Todoist project, mapped from the API v1 response. */
interface TodoistProject {
	id: string;
	name: string;
	parentId: string | null;
}

interface TodoistProjectSyncSettings {
	PrimarySyncDevice: string;
	TodoistSyncFrequency: number;
	TodoistToken: string;
	TodoistProjectFolder: string;
	/** Vault-root-relative path where notes for deleted Todoist projects are moved. */
	ArchiveFolder: string;
	/**
	 * Template string for newly created project notes.
	 * Supports the following variables:
	 *   {{TodoistId}}    — the project's unique Todoist ID
	 *   {{ProjectName}}  — the project's display name
	 *   {{TodoistUrl}}   — full URL to open the project in Todoist
	 */
	NoteTemplate: string;
}

const DEFAULT_SETTINGS: TodoistProjectSyncSettings = {
	TodoistToken: '',
	TodoistProjectFolder: 'Projects',
	TodoistSyncFrequency: 60,
	PrimarySyncDevice: '',
	ArchiveFolder: 'Projects/archive',
	NoteTemplate: [
		'---',
		'tags: project',
		'TodoistId: {{TodoistId}}',
		'url: {{TodoistUrl}}',
		'---',
		' # {{ProjectName}}',
		'[Open in Todoist]({{TodoistUrl}})',
		'```todoist',
		'"filter": "#{{ProjectName}}"',
		'"groupBy": "section"',
		'```',
		''
	].join('\n')
}

export default class TodoistProjectSync extends Plugin {
	settings: TodoistProjectSyncSettings;
	refreshIntervalID: number;

	/** Plugin entry point — loads settings and starts the sync interval. */
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TodoistSettingTab(this.app, this));
		this.setRefreshInterval();

		this.addCommand({
			id: 'sync-todoist-projects',
			name: 'Sync Todoist projects now',
			callback: async () => {
				new Notice('Syncing Todoist projects…');
				await this.updateTodoistProjectFiles();
				new Notice('Todoist projects synced.');
			}
		});
	}

	/**
	 * Fetches all projects from the Todoist API v1 using Obsidian's
	 * requestUrl (bypasses CORS restrictions in Electron).
	 *
	 * @param token  Todoist API token.
	 * @returns      Array of TodoistProject objects.
	 * @throws       If the request fails or the token is invalid (HTTP 4xx/5xx).
	 */
	async fetchTodoistProjects(token: string): Promise<TodoistProject[]> {
		const projects: TodoistProject[] = [];
		let cursor: string | null = null;

		do {
			const url = new URL('https://api.todoist.com/api/v1/projects');
			if (cursor) url.searchParams.set('cursor', cursor);

			const response = await requestUrl({
				url: url.toString(),
				headers: { 'Authorization': `Bearer ${token}` }
			});
			const body = response.json as { results: Array<{ id: string; name: string; parent_id: string | null }>; next_cursor: string | null };
			projects.push(...body.results.map(p => ({ id: p.id, name: p.name, parentId: p.parent_id })));
			cursor = body.next_cursor;
		} while (cursor);

		return projects;
	}

	/**
	 * Archives project notes whose TodoistId is no longer in the active projects list.
	 * Files already located inside the archive folder are skipped to prevent
	 * attempting to re-archive an already-archived file.
	 *
	 * @param files            All markdown files currently in the vault.
	 * @param handledProjects  Array of active Todoist project IDs.
	 */
	async archiveRemovedProjects(files: TFile[], handledProjects: string[]) {
		const archiveFolderPath = normalizePath(this.settings.ArchiveFolder);

		if (!await this.app.vault.adapter.exists(archiveFolderPath)) {
			await this.app.vault.createFolder(archiveFolderPath);
		}

		for (const file of files) {
			// Skip files already in the archive to prevent re-archiving
			if (file.path.startsWith(archiveFolderPath + '/')) {
				continue;
			}

			const metadata = this.app.metadataCache.getFileCache(file);
			if (metadata?.frontmatter?.TodoistId) {
				const todoistId: string = metadata.frontmatter.TodoistId;
				if (!handledProjects.includes(todoistId)) {
					const archivePath = normalizePath(`${archiveFolderPath}/${todoistId}.md`);
					await this.app.vault.rename(file, archivePath);
				}
			}
		}
	}

	/**
	 * Recursively creates the vault folder hierarchy for a Todoist project.
	 *
	 * If the project has a parent, this method first ensures the parent's folder
	 * exists (recursing up the tree), then creates a sub-folder named after this
	 * project inside it. Top-level projects are created directly under baseFolder.
	 *
	 * Folder creation errors (e.g. folder already exists) are silently suppressed.
	 *
	 * @param project     The project whose folder is being created.
	 * @param allProjects Full list of Todoist projects, used to resolve parent references.
	 * @param baseFolder  The root vault folder for all project notes.
	 * @returns           The vault path of the folder created for this project.
	 */
	async createProjectFolder(project: TodoistProject, allProjects: TodoistProject[], baseFolder: string): Promise<string> {
		let folderPath = baseFolder;

		if (project.parentId) {
			const parentProject = allProjects.find(p => p.id === project.parentId);
			if (parentProject) {
				// Recursively ensure the parent folder exists first
				folderPath = await this.createProjectFolder(parentProject, allProjects, baseFolder);
				folderPath = `${folderPath}/${project.name}`;
			}
		} else {
			folderPath = `${baseFolder}/${project.name}`;
		}

		// Create the folder if it doesn't already exist
		await this.app.vault.createFolder(folderPath).catch(() => {}); // Suppress errors if folder exists

		return folderPath;
	}

	/**
	 * Renders a note template, substituting {{Variable}} placeholders with
	 * values from the given Todoist project.
	 *
	 * Available variables:
	 *   {{TodoistId}}    — The project's unique Todoist ID (e.g. "2203306141")
	 *   {{ProjectName}}  — The project's display name (e.g. "Work")
	 *   {{TodoistUrl}}   — Full URL to open the project in Todoist
	 *                      (e.g. "https://todoist.com/app/project/2203306141")
	 *
	 * @param template  Template string with {{Variable}} placeholders.
	 * @param project   Todoist project providing substitution values.
	 * @returns         Rendered string with all placeholders replaced.
	 */
	renderTemplate(template: string, project: TodoistProject): string {
		const todoistUrl = `https://todoist.com/app/project/${project.id}`;
		return template
			.replaceAll('{{TodoistId}}', project.id)
			.replaceAll('{{ProjectName}}', project.name)
			.replaceAll('{{TodoistUrl}}', todoistUrl);
	}

	/**
	 * Clears any existing sync interval and starts a new one based on the
	 * current TodoistSyncFrequency setting.
	 *
	 * If frequency is 0 or less, no interval is registered (sync is disabled).
	 * Call this method after changing TodoistSyncFrequency to apply the change
	 * immediately without reloading the plugin.
	 */
	setRefreshInterval() {
		if (this.refreshIntervalID > 0)
			window.clearInterval(this.refreshIntervalID);
		if (this.settings.TodoistSyncFrequency > 0)
			this.refreshIntervalID = this.registerInterval(window.setInterval(async () => {
				console.log(new Date().toLocaleString() + ': Updating Todoist Project files');
				await this.updateTodoistProjectFiles();
				console.log(new Date().toLocaleString() + ': Todoist Project files updated');
			}, this.settings.TodoistSyncFrequency * 1000));
	}

	/**
	 * Main sync handler. Fetches all projects from Todoist and reconciles them
	 * with the vault:
	 *
	 *  - For each active project, a note is created at
	 *    `{TodoistProjectFolder}/{hierarchy}/{ProjectName}.md`.
	 *  - If a note with a matching `TodoistId` frontmatter field already exists
	 *    elsewhere in the vault, it is renamed/moved to the correct path.
	 *  - If the note was previously archived, it is restored from the archive
	 *    folder to the correct path.
	 *  - If no note exists at all, a new note is created using the configured
	 *    NoteTemplate. Template variables available in the template:
	 *      {{TodoistId}}   — the project's Todoist ID
	 *      {{ProjectName}} — the project's display name
	 *      {{TodoistUrl}}  — URL to open the project in Todoist
	 *  - Projects no longer present in Todoist have their notes moved to the
	 *    configured ArchiveFolder.
	 */
	async updateTodoistProjectFiles() {
		if (!(os.hostname() === this.settings.PrimarySyncDevice || this.settings.PrimarySyncDevice === '')) {
			console.log("Not Primary sync device - skipping Todoist sync");
			return;
		}

		// Ensure the base project folder exists
		if (!await this.app.vault.adapter.exists(this.settings.TodoistProjectFolder)) {
			this.app.vault.createFolder(this.settings.TodoistProjectFolder);
		}

		try {
			const projects = await this.fetchTodoistProjects(this.settings.TodoistToken);
			const files = this.app.vault.getMarkdownFiles();

			// Build a map from TodoistId -> TFile for O(1) lookup
			const filesById: Record<string, TFile> = {};
			files.forEach(file => {
				const metadata = this.app.metadataCache.getFileCache(file);
				if (metadata?.frontmatter?.TodoistId) {
					filesById[metadata.frontmatter.TodoistId] = file;
				}
			});

			const handledProjects: string[] = [];
			for (const project of projects) {
				handledProjects.push(project.id);

				const projectFolderPath = await this.createProjectFolder(project, projects, this.settings.TodoistProjectFolder);
				const notePath = normalizePath(`${projectFolderPath}/${project.name}.md`);

				if (this.app.vault.getAbstractFileByPath(notePath)) {
					// Note exists at the correct path — rename any stale duplicate if present
					const existingFile = filesById[project.id];
					if (existingFile && existingFile.path !== notePath) {
						await this.app.vault.rename(existingFile, notePath);
					}
				} else {
					// Note is not at the correct path — find or create it
					const existingFile = filesById[project.id];
					if (existingFile) {
						// A file with this TodoistId exists somewhere else in the vault — move it
						await this.app.vault.rename(existingFile, notePath);
					} else {
						// Check if the note was previously archived — restore it if so
						const archivePath = normalizePath(`${this.settings.ArchiveFolder}/${project.id}.md`);
						const archivedFile = this.app.vault.getAbstractFileByPath(archivePath);
						if (archivedFile instanceof TFile) {
							await this.app.vault.rename(archivedFile, notePath);
						} else {
							// No existing note anywhere — create a fresh one from the template
							await this.app.vault.create(
								notePath,
								this.renderTemplate(this.settings.NoteTemplate, project)
							);
						}
					}
				}
			}

			// Archive notes for projects that no longer exist in Todoist
			await this.archiveRemovedProjects(files, handledProjects);

		} catch (error) {
			console.error("Error syncing Todoist projects:", error);
		}
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}


class TodoistSettingTab extends PluginSettingTab {
	plugin: TodoistProjectSync;

	constructor(app: App, plugin: TodoistProjectSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Todoist Project Sync Settings' });

		new Setting(containerEl)
			.setName('Todoist API key')
			.setDesc('Your Todoist API token. Find it at Todoist Settings → Integrations → Developer.')
			.addText(text => text
				.setPlaceholder('Enter your API token')
				.setValue(this.plugin.settings.TodoistToken)
				.onChange(async (value) => {
					this.plugin.settings.TodoistToken = value;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Test API key')
				.onClick(async () => {
					button.setButtonText('Testing…').setDisabled(true);
					try {
						await this.plugin.fetchTodoistProjects(this.plugin.settings.TodoistToken);
						new Notice('✓ API key is valid.');
					} catch {
						new Notice('✗ Invalid API key or network error.');
					} finally {
						button.setButtonText('Test API key').setDisabled(false);
					}
				}));

		new Setting(containerEl)
			.setName('Project folder')
			.setDesc('Vault folder where project notes and sub-folders are created. Created automatically if it does not exist. Default: "Projects".')
			.addText(text => text
				.setPlaceholder('Projects')
				.setValue(this.plugin.settings.TodoistProjectFolder)
				.onChange(async (value) => {
					this.plugin.settings.TodoistProjectFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Archive folder')
			.setDesc('Vault path where notes for deleted Todoist projects are moved. If a project is restored in Todoist, its note is automatically moved back. Update this if you change the project folder. Default: "Projects/archive".')
			.addText(text => text
				.setPlaceholder('Projects/archive')
				.setValue(this.plugin.settings.ArchiveFolder)
				.onChange(async (value) => {
					this.plugin.settings.ArchiveFolder = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Note template')
			.setDesc(
				'Template used when creating a new project note. ' +
				'Changes only affect newly created notes, not existing ones. ' +
				'Available variables: ' +
				'{{TodoistId}} (project ID), ' +
				'{{ProjectName}} (project display name), ' +
				'{{TodoistUrl}} (link to open project in Todoist).'
			)
			.addTextArea(text => {
				text
					.setPlaceholder('Enter template...')
					.setValue(this.plugin.settings.NoteTemplate)
					.onChange(async (value) => {
						this.plugin.settings.NoteTemplate = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 12;
				text.inputEl.cols = 50;
				return text;
			});

		new Setting(containerEl)
			.setName('Primary sync device')
			.setDesc(
				'If set, syncing only runs on the device with this hostname — prevents conflicts when Obsidian is open on multiple devices. ' +
				'The hostname of this device is "' + os.hostname() + '".'
			)
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.PrimarySyncDevice)
				.onChange(async (value) => {
					this.plugin.settings.PrimarySyncDevice = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync frequency (seconds)')
			.setDesc('How often to pull project changes from Todoist. Set to 0 to disable automatic sync. Default: 60.')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(this.plugin.settings.TodoistSyncFrequency.toString())
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 0) {
						this.plugin.settings.TodoistSyncFrequency = parsed;
						await this.plugin.saveSettings();
						this.plugin.setRefreshInterval();
					}
				}));
	}
}
