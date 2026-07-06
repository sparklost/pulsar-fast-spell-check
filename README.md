# fast-spell-check
A package for Pulsar Editor that spellchecks editor in real time.

## Features
- Real time spell checking
- Low CPU usage even on huge files (only the first time it takes longer to scan the file, on later edits its negligible)
- Can use any ispell-compatible spellchecker (aspell/hunspell)
- Words can be added to spellchecker-native user dictionary
- Has whitelist and blacklist for spelling scopes (eg spellcheck only comments in the code)
- Can be toggled ON/OFF
- Misspelled words can be fixed (or added to dictionary) with right-click context menu
- `Alt+,`/`Alt+.` bindings to go to previous/next misspelled word and show quick-fix menu
- Quick-fix menu is showing suggested fixes for this word or option to add it to dictionary
- Quick-fix menu can be navigated with arrow keys
- Minimap integration

## Setup
Either aspell or hunspell must be installed on system, and have at least one dictionary.  
**Aspell is recommended** because it has much better performance and better corrections.  
After spellchecker is installed, verify that it has dictionaries too:  
Aspell: `aspell dump dicts`  
Hunspell: `hunspell -D`  
If using hunspell then change Spellchecker Path in config to `hunspell`.  
Pick one and configure it in package settings.  
Usually Linux distributions offer dictionaries as separate packages. Base aspell should already have en_US dictionary preinstalled.  

### Windows
Aspell for windows can be found [here](https://github.com/adamyg/aspell-win32). Do not install x64 version as it appears broken at the time of writing.  
Dictionary for specific language must be installed alongside aspell base program.  
If aspell is not available in PATH then in package config change Spellchecker Path to path to aspell executable (usually `C:\Program Files (x86)\Aspell-0.60\bin\aspell.exe`)

## Configuration
This package allows for custom flags to be passed to spellchecker. See them with `aspell --help` or `hunspell --help`.  
Grammars and Excluded Grammars options allow for fine-graining what languages and their scopes will be spellchecked.  
Scopes can be seen with `Editor: Log Cursor Scopes` pulsar command, which will show current language and language scope at the cursor.
