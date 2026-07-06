const { spawn } = require("child_process");

class SpellerBackend {
  constructor(spellcheckerPath, language, personalDictPath, customFlags) {
    this.spellcheckerPath = spellcheckerPath || "aspell";
    this.language = language || "en_US";
    this.personalDictPath = personalDictPath || null;
    this.customFlags = customFlags || "";
    this.child = null;
    this.queue = [];
    this.isProcessing = false;
    this.stdoutBuffer = "";
    this.currentResponseLines = [];
    this.expectingStartupBlankLine = false;
    this.startProcess();
  }

  startProcess() {
    this.killProcess();
    const parsedFlags = this.customFlags.split(/\s+/).filter(Boolean);
    const args = ["-a", ...parsedFlags];
    if (this.personalDictPath) {
      args.push("-p", this.personalDictPath);
      if (this.spellcheckerPath && this.spellcheckerPath.includes("aspell")) {
        const preplPath = this.personalDictPath.endsWith(".dict")
          ? this.personalDictPath.slice(0, -5) + ".prepl"
          : this.personalDictPath + ".prepl";
        args.push("--repl", preplPath);
      }
    }
    if (this.language) {
      args.push("-d", this.language);
    }
    try {
      this.child = spawn(this.spellcheckerPath, args);
    } catch (err) {
      this.handleProcessFailure(err);
      return;
    }
    this.child.stdout.on("data", (data) => {
      this.stdoutBuffer += data.toString();
      this.handleIncomingData();
    });
    this.child.stderr.on("data", () => {});
    this.child.on("error", (err) => {
      this.handleProcessFailure(err);
    });
    this.child.on("close", (code) => {
      this.child = null;
      if (this.isProcessing && this.queue.length > 0) {
        const failedTask = this.queue.shift();
        failedTask.reject(new Error(`Spelling engine disconnected unexpectedly (Exit Code: ${code}).`));
        this.isProcessing = false;
        this.executeNextTask();
      }
    });
  }

  handleProcessFailure(err) {
    if (this.queue.length > 0) {
      const failedTask = this.queue.shift();
      failedTask.reject(new Error(`Failed to communicate with spelling engine: ${err.message}`));
      this.isProcessing = false;
      this.executeNextTask();
    }
  }

  checkLine(lineText) {
    return new Promise((resolve, reject) => {
      this.queue.push({ lineText, resolve, reject });
      this.executeNextTask();
    });
  }

  executeNextTask() {
    if (this.isProcessing || this.queue.length === 0) return;
    if (!this.child) {
      this.startProcess();
      if (!this.child) {
        const failedTask = this.queue.shift();
        failedTask.reject(new Error("Spelling engine background daemon failed to start."));
        return;
      }
    }
    this.isProcessing = true;
    const task = this.queue[0];
    this.child.stdin.write("^" + task.lineText + "\n");
  }

  addWord(word) {
    if (!word || !this.child || !this.child.stdin) return;
    const cleanedWord = word.trim();
    this.child.stdin.write(`*${cleanedWord}\n`);
    this.child.stdin.write("#\n");
  }

  handleIncomingData() {
    let newlineIndex;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.substring(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.substring(newlineIndex + 1);
      if (line.startsWith("@(#)")) {
        this.expectingStartupBlankLine = true;
        continue;
      }
      if (line === "") {
        if (this.expectingStartupBlankLine) {
          this.expectingStartupBlankLine = false;
          continue;
        }
        if (this.isProcessing && this.queue.length > 0) {
          const finishedTask = this.queue.shift();
          const misspellings = this.parseResponseLines(this.currentResponseLines);
          this.currentResponseLines = [];
          this.isProcessing = false;
          finishedTask.resolve(misspellings);
          this.executeNextTask();
        }
        continue;
      }
      this.expectingStartupBlankLine = false;
      if (this.isProcessing) {
        this.currentResponseLines.push(line);
      }
    }
  }

  parseResponseLines(lines) {
    const misspellings = [];
    for (const line of lines) {
      if (line.startsWith("&")) {
        const parts = line.match(/^& (\S+) \d+ (\d+): (.+)$/);
        if (parts) {
          misspellings.push({
            word: parts[1],
            offset: parseInt(parts[2], 10) - 1,
            suggestions: parts[3].split(", ").slice(0, 5)
          });
        }
      } else if (line.startsWith("#")) {
        const parts = line.match(/^# (\S+) \d+ (\d+)/);
        if (parts) {
          misspellings.push({
            word: parts[1],
            offset: parseInt(parts[2], 10) - 1,
            suggestions: []
          });
        }
      }
    }
    return misspellings;
  }

  updateConfig(spellcheckerPath, language, customFlags) {
    this.spellcheckerPath = spellcheckerPath;
    this.language = language;
    this.customFlags = customFlags || "";
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      task.reject(new Error("Configuration changed. Resetting engine."));
    }
    this.isProcessing = false;
    this.startProcess();
  }

  killProcess() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.stdoutBuffer = "";
    this.currentResponseLines = [];
    this.expectingStartupBlankLine = false;
  }

  destroy() {
    this.killProcess();
  }
}

module.exports = SpellerBackend;
