import { App, Editor, FileManager, FileSystemAdapter, FrontMatterCache, MarkdownView, Modal, normalizePath, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import { Project, TodoistApi } from "@doist/todoist-api-typescript"// Remember to rename these classes and interfaces!
import { Console, error } from 'console';
import * as os from 'os';
interface TodoistProjectSyncSettings {
	PrimarySyncDevice: string;
	TodoistSyncFrequency: number;
	TodoistToken: string;
	TodoistProjectFolder: string;
}

const DEFAULT_SETTINGS: TodoistProjectSyncSettings = {
	TodoistToken: '',
	TodoistProjectFolder: 'Projects',
	TodoistSyncFrequency: 60,
	PrimarySyncDevice: ''
}

export default class TodoistProjectSync extends Plugin {
	settings: TodoistProjectSyncSettings;
	refreshIntervalID: number;
	todoistApi: TodoistApi;

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new TodoistSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
		// 	console.log('click', evt);
		// });

		this.setRefreshInterval();
	}
// Inside your TodoistProjectSync class

async archiveRemovedProjects(files: TFile[], handledProjects: string[]) {
	// Ensure the archive folder exists
	const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const quarter = Math.floor(month / 3) + 1; // 1 for Jan-Mar, 2 for Apr-Jun, etc.
	const archiveFolderPath = `Archive/${year}/Q${quarter}/${TodoistProjectFolder}`;
	if (!await this.app.vault.adapter.exists(archiveFolderPath)) {
		await this.app.vault.createFolder(archiveFolderPath);
	}

	// Loop through each file to check if it’s still in Todoist projects
	for (const file of files) {
		const metadata = this.app.metadataCache.getFileCache(file);
		if (metadata?.frontmatter?.TodoistId) {
			const todoistId = metadata.frontmatter.TodoistId;

			// If the project is no longer in the list of handled projects, archive it
			if (!handledProjects.includes(todoistId)) {
				await this.app.vault.rename(file, `${archiveFolderPath}/${todoistId}.md`);
			}
		}
	}
}
async createProjectFolder(project: Project, allProjects: Project[], baseFolder: string): Promise<string> {
	// Check if the project has a parent, and if so, create the folder inside the parent’s folder
	let folderPath = baseFolder;

	if (project.parentId) {
		const parentProject = allProjects.find((p: Project) => p.id === project.parentId);
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
	setRefreshInterval() {
		if (this.refreshIntervalID > 0)
			window.clearInterval(this.refreshIntervalID);
		if (this.settings.TodoistSyncFrequency > 0)
			this.refreshIntervalID= this.registerInterval(window.setInterval(async () => {
				console.log(new Date().toLocaleString() + ': Updating Todoist Project files');
				await this.updateTodoistProjectFiles();
				console.log(new Date().toLocaleString() + ': Todoist Project files updated');
			}
				, this.settings.TodoistSyncFrequency * 1000));

	}
	async updateTodoistProjectFiles() {
		if (!(os.hostname() === this.settings.PrimarySyncDevice || this.settings.PrimarySyncDevice === '')) {
			console.log("Not Primary sync device - skipping Todoist sync");
			return;
		}
	
		this.todoistApi = new TodoistApi(this.settings.TodoistToken);
	
		// Ensure the Todoist Project Folder exists
		if (!await this.app.vault.adapter.exists(this.settings.TodoistProjectFolder)) {
			this.app.vault.createFolder(this.settings.TodoistProjectFolder);
		}
	
		try {
			const projects = await this.todoistApi.getProjects();
			const files = this.app.vault.getMarkdownFiles();
			const filesById = {};
	
			files.forEach(file => {
				const Metadata = this.app.metadataCache.getFileCache(file);
				if (Metadata?.frontmatter?.TodoistId) {
					filesById[Metadata.frontmatter.TodoistId] = file;
				}
			});
	
			const handledProjects = [];
			for (const project of projects) {
				handledProjects.push(project.id);
	
				// Create project folder path based on hierarchy
				const projectFolderPath = await this.createProjectFolder(project, projects, this.settings.TodoistProjectFolder);
	
				// Define the path for the note inside its dedicated folder
				const notePath = normalizePath(`${projectFolderPath}/${project.name}.md`);
				if (!this.app.vault.getAbstractFileByPath(notePath)) {
					// Create the note if it doesn't exist
					await this.app.vault.create(
						notePath,
						`---\ntags: effort\nTodoistId: ${project.id}\nurl: https://todoist.com/app/project/${project.id} \n---\n\n> [!tasks]+ Tasks\n>\`\`\`todoist\n"name": ""\n"filter": "#${project.name}"\ngrouBy: section\n>\`\`\`\n\n- `
					);
					// Create Todoist task with a link to the new note
					await createTodoistTaskForProject(project, notePath);
				} else {
					// If note already exists, rename or update it
					const existingFile = filesById[project.id];
					const existingNotePath = normalizePath(`${projectFolderPath}/${project.name}.md`);
					
					if (existingFile && existingFile.path !== notePath) {
						await this.app.vault.rename(existingFile, notePath);
					}
				}
			}
			
			async function createTodoistTaskForProject(project, notePath) {
				const obsidianNoteLink = `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(notePath)}`;
				
				const taskData = {
					content: `[Project note for ${project.name}](${obsidianNoteLink})`,
					project_id: project.id,
				};
				
				try {
					const response = await fetch("https://api.todoist.com/rest/v1/tasks", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Authorization": `Bearer ${todoistApiToken}`
						},
						body: JSON.stringify(taskData)
					});
					
					if (!response.ok) {
						throw new Error(`Failed to create Todoist task: ${response.statusText}`);
					}
					
					console.log("Todoist task created successfully!");
				} catch (error) {
					console.error("Error creating Todoist task:", error);
				}
			}
		
		
				else {
					// If note already exists, rename or update it
					const existingFile = filesById[project.id];
					const existingNotePath = normalizePath(`${projectFolderPath}/${project.name}.md`); // Include "! " for renaming
					if (existingFile && existingFile.path !== notePath) {
						await this.app.vault.rename(existingFile, notePath);
					}
				}
			}

			// Archive any files not matching the current projects in Todoist
			await this.archiveRemovedProjects(files, handledProjects);
	
		} catch (error) {
			console.error("Error syncing Todoist projects:", error);
		}
	}
	getPath(projects: Project[], currentProjectId?: string): string {
		let result = "";
		if (currentProjectId) {
			const currentProject = projects.find(p => p.id === currentProjectId);
			if (currentProject?.parentId) {
				const parentProj = projects.find((proj: Project) => proj.id === currentProject?.parentId);
				if (parentProj)
					result = this.getPath(projects, parentProj.id) + "/" + parentProj.name;
				else
					throw new RangeError("Project tree structure in Todoist is malformed. Project with ID: " + currentProject.parentId + "Does not exist");
			}
		}
		return result;

	}
	// public async addYamlProp(propName: string, propValue: string, file: TFile): Promise<void> {
	// 	const fileContent: string = await this.app.vault.read(file);
	// 	const isYamlEmpty: boolean = (this.app.metadataCache.getFileCache(file)?.frontmatter === undefined && !fileContent.match(/^-{3}\s*\n*\r*-{3}/));


	// 	const splitContent = fileContent.split("\n");
	// 	if (isYamlEmpty) {
	// 		splitContent.unshift("---");
	// 		splitContent.unshift(`${propName}: ${propValue}`);
	// 		splitContent.unshift("---");
	// 	}
	// 	else {
	// 		splitContent.splice(1, 0, `${propName}: ${propValue}`);
	// 	}

	// 	const newFileContent = splitContent.join("\n");
	// 	await this.app.vault.modify(file, newFileContent);
	// }

	onunload() {

	}

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

		containerEl.createEl('h2', { text: 'Settings.' });

		new Setting(containerEl)
			.setName('Todoist API Key')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.TodoistToken)
				.onChange(async (value) => {
					this.plugin.settings.TodoistToken = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Todoist project Folder')
			.setDesc('folder for projects')
			.addText(text => text
				.setPlaceholder('enter path')
				.setValue(this.plugin.settings.TodoistProjectFolder)
				.onChange(async (value) => {
					this.plugin.settings.TodoistProjectFolder = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Primary sync device')
			.setDesc('if this field is set, projects will only sync on the device with this name. This is to prevent sync-problems if projects are updated on multiple devices. The name of this device is"' + os.hostname() + '".')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.PrimarySyncDevice)
				.onChange(async (value) => {
					this.plugin.settings.PrimarySyncDevice = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Todoist sync frequency in seconds')
			.setDesc('Sync frequency in seconds')
			.addText(Number => Number
				.setPlaceholder("0")
				.setValue(this.plugin.settings.TodoistSyncFrequency.toString())
				.onChange(async (value) => {
					this.plugin.settings.TodoistSyncFrequency = parseInt(value);

					await this.plugin.saveSettings();
					this.plugin.setRefreshInterval();

				}));

	}
}


