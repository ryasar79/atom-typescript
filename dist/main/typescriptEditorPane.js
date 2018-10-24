"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const atom_1 = require("atom");
const lodash_1 = require("lodash");
const utils_1 = require("../utils");
const utils_2 = require("./atom/utils");
const typescriptBuffer_1 = require("./typescriptBuffer");
class TypescriptEditorPane {
    constructor(editor, opts) {
        this.editor = editor;
        this.opts = opts;
        // Timestamp for activated event
        this.activeAt = 0;
        this.isTypescript = false;
        this.isActive = false;
        this.isOpen = false;
        this.occurrenceMarkers = [];
        this.subscriptions = new atom_1.CompositeDisposable();
        this.updateMarkersDB = lodash_1.debounce(() => utils_1.handlePromise(this.updateMarkers()), 100);
        this.onActivated = () => {
            this.activeAt = Date.now();
            this.isActive = true;
            const filePath = this.buffer.getPath();
            if (this.isTypescript && filePath !== undefined) {
                utils_1.handlePromise(this.opts.statusPanel.show());
                // The first activation might happen before we even have a client
                if (this.client) {
                    utils_1.handlePromise(this.client.execute("geterr", {
                        files: [filePath],
                        delay: 100,
                    }));
                    utils_1.handlePromise(this.opts.statusPanel.update({ version: this.client.version }));
                }
            }
            utils_1.handlePromise(this.opts.statusPanel.update({ tsConfigPath: this.configFile }));
        };
        this.onDeactivated = () => {
            this.isActive = false;
            utils_1.handlePromise(this.opts.statusPanel.hide());
        };
        this.onChanged = () => {
            if (!this.client)
                return;
            const filePath = this.buffer.getPath();
            if (filePath === undefined)
                return;
            utils_1.handlePromise(this.opts.statusPanel.update({ buildStatus: undefined }));
            utils_1.handlePromise(this.client.execute("geterr", {
                files: [filePath],
                delay: 100,
            }));
        };
        this.onDidChangeCursorPosition = ({ textChanged }) => {
            if (!this.isTypescript || !this.isOpen)
                return;
            if (textChanged) {
                this.clearOccurrenceMarkers();
                return;
            }
            this.updateMarkersDB();
        };
        this.onDidDestroy = () => {
            this.dispose();
        };
        this.onOpened = async () => {
            const filePath = this.buffer.getPath();
            if (filePath === undefined)
                return;
            this.client = await this.opts.getClient(filePath);
            // onOpened might trigger before onActivated so we can't rely on isActive flag
            if (atom.workspace.getActiveTextEditor() === this.editor) {
                this.isActive = true;
                await this.opts.statusPanel.update({ version: this.client.version });
            }
            if (this.isTypescript) {
                await this.client.execute("geterr", {
                    files: [filePath],
                    delay: 100,
                });
                this.isOpen = true;
                try {
                    const result = await this.client.execute("projectInfo", {
                        needFileNameList: false,
                        file: filePath,
                    });
                    this.configFile = result.body.configFileName;
                    if (this.isActive) {
                        await this.opts.statusPanel.update({ tsConfigPath: this.configFile });
                    }
                    const options = await utils_2.getProjectCodeSettings(this.configFile);
                    await this.client.execute("configure", {
                        file: filePath,
                        formatOptions: options,
                    });
                }
                catch (e) {
                    if (window.atom_typescript_debug)
                        console.error(e);
                }
            }
        };
        this.onSaved = () => {
            this.opts.onSave(this);
            utils_1.handlePromise(this.compileOnSave());
        };
        this.checkIfTypescript = () => {
            this.isTypescript = utils_2.isTypescriptEditorWithPath(this.editor);
            // Add 'typescript-editor' class to the <atom-text-editor> where typescript is active.
            if (this.isTypescript) {
                atom.views.getView(this.editor).classList.add("typescript-editor");
            }
        };
        this.buffer = typescriptBuffer_1.TypescriptBuffer.create(editor.getBuffer(), opts.getClient);
        this.subscriptions.add(this.buffer.events.on("changed", this.onChanged), this.buffer.events.on("closed", this.opts.onClose), this.buffer.events.on("opened", this.onOpened), this.buffer.events.on("saved", this.onSaved));
        this.checkIfTypescript();
        this.subscriptions.add(editor.onDidChangePath(this.checkIfTypescript), editor.onDidChangeGrammar(this.checkIfTypescript), this.editor.onDidChangeCursorPosition(this.onDidChangeCursorPosition), this.editor.onDidDestroy(this.onDidDestroy));
    }
    dispose() {
        atom.views.getView(this.editor).classList.remove("typescript-editor");
        this.subscriptions.dispose();
        this.opts.onDispose(this);
    }
    clearOccurrenceMarkers() {
        for (const marker of this.occurrenceMarkers) {
            marker.destroy();
        }
    }
    async updateMarkers() {
        if (!this.client)
            return;
        const filePath = this.buffer.getPath();
        if (filePath === undefined)
            return;
        const pos = this.editor.getLastCursor().getBufferPosition();
        this.clearOccurrenceMarkers();
        try {
            const result = await this.client.execute("occurrences", {
                file: filePath,
                line: pos.row + 1,
                offset: pos.column + 1,
            });
            for (const ref of result.body) {
                const marker = this.editor.markBufferRange(utils_2.spanToRange(ref));
                this.editor.decorateMarker(marker, {
                    type: "highlight",
                    class: "atom-typescript-occurrence",
                });
                this.occurrenceMarkers.push(marker);
            }
        }
        catch (e) {
            if (window.atom_typescript_debug)
                console.error(e);
        }
    }
    async compileOnSave() {
        const { client } = this;
        if (!client)
            return;
        const filePath = this.buffer.getPath();
        if (filePath === undefined)
            return;
        const result = await client.execute("compileOnSaveAffectedFileList", {
            file: filePath,
        });
        await this.opts.statusPanel.update({ buildStatus: undefined });
        const fileNames = lodash_1.flatten(result.body.map(project => project.fileNames));
        if (fileNames.length === 0)
            return;
        try {
            const promises = fileNames.map(file => client.execute("compileOnSaveEmitFile", { file }));
            const saved = await Promise.all(promises);
            if (!saved.every(res => !!res.body)) {
                throw new Error("Some files failed to emit");
            }
            await this.opts.statusPanel.update({ buildStatus: { success: true } });
        }
        catch (error) {
            const e = error;
            console.error("Save failed with error", e);
            await this.opts.statusPanel.update({ buildStatus: { success: false, message: e.message } });
        }
    }
}
exports.TypescriptEditorPane = TypescriptEditorPane;
//# sourceMappingURL=typescriptEditorPane.js.map