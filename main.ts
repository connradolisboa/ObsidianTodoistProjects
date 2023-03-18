import { App, Editor, FileManager, FileSystemAdapter, MarkdownView, Modal, normalizePath, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import { Project, TodoistApi } from "@doist/todoist-api-typescript"// Remember to rename these classes and interfaces!
import { Console } from 'console';

interface MyPluginSettings {
	TodoistToken: string;
	TodoistProjectFolder: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	TodoistToken: 'default',
	TodoistProjectFolder: 'Projects'
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
		// 	console.log('click', evt);
		// });

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(async () => {
			console.log('setInterval');
		///	Object.entries(app.commands.commands).filter(([, val]) => val.name.includes("Reload app without saving")).forEach(([id]) => console.log(id))


//My result:

//app:reload
			var folder=	 this.app.vault.getAbstractFileByPath(normalizePath("/TodoistProjects/Home improvement/build Wall"));
			const api = new TodoistApi(this.settings.TodoistToken);
		if (!await this.app.vault.adapter.exists(this.settings.TodoistProjectFolder))
			this.app.vault.createFolder(this.settings.TodoistProjectFolder);

			api.getProjects()
				.then((projects: Project[]) => {
					var 	reloadNeeded=false;
					var cleanupDone=false;
					var files = this.app.vault.getFiles();
					var filesById: { [id: string] : TFile; } = {};
					files.forEach(file => {
						var Metadata = this.app.metadataCache.getFileCache(file);
						// console.log(file.name+":")
						// console.log(Metadata?.frontmatter?.TodoistId);
if (Metadata?.frontmatter?.TodoistId)
												filesById[Metadata?.frontmatter?.TodoistId]=file;
						
					});

					projects.forEach(async element => {
						var filepath = this.getPath(projects, element.id);
						if (!await this.app.vault.adapter.exists(this.settings.TodoistProjectFolder+filepath))
						await this.app.vault.createFolder(this.settings.TodoistProjectFolder+filepath);
			
						var filename = this.settings.TodoistProjectFolder +filepath+ '/' + element.name + '.md';

						if (files.filter(file => file.path == filename).length == 0 ) {
							if (!filesById[element.id])
							{
								await this.app.vault.create(filename, "---\nTodoistId: "+element.id+"\n---\n["+element.name+"](https://todoist.com/app/project/" + element.id + ")"
								+"\n```todoist \n{\n\"name\": \""+element.name+"\", \"filter\": \"#" + element.name + "\"\n }\n```\n");
							}
							else
							{
								var oldPath = "/"+filesById[element.id].path.substring(0,filesById[element.id].path.length-(element.name+".md").length-1);
								if (!(await this.app.vault.adapter.exists("/"+filename)) &&(await this.app.vault.adapter.exists("/"+filesById[element.id].path)))
{								console.log("moving: "+ (filename));
console.log (filesById[element.id]);
console.log(filename);

								await this.app.vault.rename(filesById[element.id],filename);
							
								var folderToDelete=	 this.app.vault.getAbstractFileByPath(normalizePath(oldPath)) as TFolder;
								var keepDeleting=true;
								if (folderToDelete.children.length==0)
{								while (keepDeleting)
								{
									var nextfolderToDelete=	 folderToDelete?.parent;
										await this.app.vault.delete(folderToDelete!!);
										reloadNeeded=true;
										folderToDelete=nextfolderToDelete!!;
										if (folderToDelete.children.length>0)
											keepDeleting=false;
								}

							}
						}
					}
						}
cleanupDone=true;
					});
				})
				.catch((error) => console.log(error))
		}
			, 10 * 1000));
	}
	getPath(projects: Project[], currentProjectId?: string): string {
		var result = "";
		if (currentProjectId) {
			var currentProject = projects.find(p => p.id === currentProjectId);
			if (currentProject?.parentId) {
				let parentProj = projects.find((proj: Project) => proj.id === currentProject?.parentId);
				result = this.getPath(projects, parentProj?.id) + "/"+parentProj?.name;
			}
		}
		return result;

	}
   
	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Settings for my awesome plugin.' });

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

	}
}

