/* eslint-disable no-console */
import {Fatal, Bug, cleanSingleStackTracePath} from './error.js'
import {isUnitTest, isVerbose} from './environment/local.js'
import constants from './constants.js'
import {PackageManager} from './node/node-package-manager.js'
import {generateRandomUUID} from './id.js'
import {
  mkdirSync as fileMkdirSync,
  readSync as fileReadSync,
  sizeSync as fileSizeSync,
  touchSync as fileTouchSync,
} from './file.js'
import {join as pathJoin} from './path.js'
import {page} from './system.js'
import {colors} from './node/colors.js'
import {
  ColorContentToken,
  CommandContentToken,
  ContentToken,
  ErrorContentToken,
  HeadingContentToken,
  ItalicContentToken,
  JsonContentToken,
  LinesDiffContentToken,
  LinkContentToken,
  PathContentToken,
  RawContentToken,
  SubHeadingContentToken,
} from './content-tokens.js'
import StackTracey from 'stacktracey'
import {AbortController, AbortSignal} from 'abort-controller'
import stripAnsi from 'strip-ansi'
import {Transform, TransformCallback, TransformOptions, Writable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {WriteStream, createWriteStream, createReadStream, unlinkSync} from 'node:fs'
import {EOL} from 'node:os'
import type {Change} from 'diff'

export {default as logUpdate} from 'log-update'

const logFileName = 'shopify.cli.log'
const maxLogFileSize = 5 * 1024 * 1024
const sizePerLogLine = 50
let logFileStream: WriteStream
let commandUuid: string
let logFilePath: string
let truncating = false

class LinesTruncatorTransformer extends Transform {
  linesToRetain: string[] = []

  constructor(readonly numLinesToRetain: number = 10, opts?: TransformOptions) {
    super(opts)
  }

  _transform(chunk: string, encoding: BufferEncoding, callback: TransformCallback): void {
    this.linesToRetain = this.linesToRetain.concat(chunk.toString().split(/(\r\n|\r|\n)/g))
    if (this.linesToRetain.length > this.numLinesToRetain) {
      this.linesToRetain = this.linesToRetain.splice(this.linesToRetain.length - this.numLinesToRetain)
    }
    callback()
  }

  _flush(callback: TransformCallback): void {
    this.push(this.linesToRetain.join(EOL))
    callback()
  }
}

export function initiateLogging(options: {logDir?: string} = {}) {
  if (isUnitTest()) return
  commandUuid = generateRandomUUID()
  logFilePath = getLogFilePath(options)
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  truncateLogs(logFilePath)
  logFileStream = createWriteStream(logFilePath, {flags: 'a'})
}

function getLogFilePath(options: {logDir?: string} = {}) {
  if (!logFilePath) {
    const logDir = options.logDir || constants.paths.directories.cache.path()
    fileMkdirSync(logDir)
    logFilePath = pathJoin(logDir, logFileName)
    fileTouchSync(logFilePath)
  }

  return logFilePath
}

// Shaves off older log lines if logs are over maxLogFileSize long.
async function truncateLogs(logFile: string) {
  if (truncating) {
    return
  }
  const tmpLogFile = logFile.concat('.tmp')
  if (fileSizeSync(logFile) > maxLogFileSize) {
    truncating = true
    const truncateLines = new LinesTruncatorTransformer(calculateNumLinesToRetain())
    await pipeline(createReadStream(logFile), truncateLines, createWriteStream(tmpLogFile)).then(async () => {
      await pipeline(createReadStream(tmpLogFile), createWriteStream(logFile))
      unlinkSync(tmpLogFile)
      truncating = false
    })
  }
}

function calculateNumLinesToRetain(): number {
  return Math.floor(maxLogFileSize / sizePerLogLine)
}

export type Logger = (message: string) => void

export class TokenizedString {
  value: string
  constructor(value: string) {
    this.value = value
  }
}

export type Message = string | TokenizedString

export const token = {
  raw: (value: string) => {
    return new RawContentToken(value)
  },
  genericShellCommand: (value: Message) => {
    return new CommandContentToken(value)
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: (value: any) => {
    return new JsonContentToken(value)
  },
  path: (value: Message) => {
    return new PathContentToken(value)
  },
  link: (value: Message, link: string) => {
    return new LinkContentToken(value, link)
  },
  heading: (value: Message) => {
    return new HeadingContentToken(value)
  },
  subheading: (value: Message) => {
    return new SubHeadingContentToken(value)
  },
  italic: (value: Message) => {
    return new ItalicContentToken(value)
  },
  errorText: (value: Message) => {
    return new ErrorContentToken(value)
  },
  cyan: (value: Message) => {
    return new ColorContentToken(value, colors.cyan)
  },
  yellow: (value: Message) => {
    return new ColorContentToken(value, colors.yellow)
  },
  magenta: (value: Message) => {
    return new ColorContentToken(value, colors.magenta)
  },
  green: (value: Message) => {
    return new ColorContentToken(value, colors.green)
  },
  packagejsonScript: (packageManager: PackageManager, scriptName: string, ...scriptArgs: string[]) => {
    return new CommandContentToken(formatPackageManagerCommand(packageManager, scriptName, scriptArgs))
  },
  successIcon: () => {
    return new ColorContentToken('✔', colors.green)
  },
  failIcon: () => {
    return new ErrorContentToken('✖')
  },
  linesDiff: (value: Change[]) => {
    return new LinesDiffContentToken(value)
  },
}

function formatPackageManagerCommand(packageManager: PackageManager, scriptName: string, scriptArgs: string[]): string {
  switch (packageManager) {
    case 'yarn': {
      const pieces = ['yarn', scriptName, ...scriptArgs]
      return pieces.join(' ')
    }
    case 'pnpm':
    case 'npm': {
      const pieces = [packageManager, 'run', scriptName]
      if (scriptArgs.length > 0) {
        pieces.push('--')
        pieces.push(...scriptArgs)
      }
      return pieces.join(' ')
    }
  }
}

export function content(strings: TemplateStringsArray, ...keys: (ContentToken<unknown> | string)[]): TokenizedString {
  let output = ``
  strings.forEach((string, i) => {
    output += string
    if (i >= keys.length) {
      return
    }
    const token = keys[i]!

    if (typeof token === 'string') {
      output += token
    } else {
      const enumTokenOutput = token.output()

      if (Array.isArray(enumTokenOutput)) {
        enumTokenOutput.forEach((line: string) => {
          output += line
        })
      } else {
        output += enumTokenOutput
      }
    }
  })
  return new TokenizedString(output)
}

/** Log levels */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'

/**
 * It maps a level to a numeric value.
 * @param level {LogLevel} The level for which we'll return its numeric value.
 * @returns The numeric value of the level.
 */
const logLevelValue = (level: LogLevel): number => {
  switch (level) {
    case 'trace':
      return 10
    case 'debug':
      return 20
    case 'info':
      return 30
    case 'warn':
      return 40
    case 'error':
      return 50
    case 'fatal':
      return 60
    default:
      return 30
  }
}

/**
 *
 * @returns {LogLevel} It returns the log level set by the user.
 */
export const currentLogLevel = (): LogLevel => {
  if (isVerbose()) {
    return 'debug'
  } else {
    return 'info'
  }
}

export const shouldOutput = (logLevel: LogLevel): boolean => {
  if (isUnitTest()) {
    return false
  }
  const currentLogLevelValue = logLevelValue(currentLogLevel())
  const messageLogLevelValue = logLevelValue(logLevel)
  return messageLogLevelValue >= currentLogLevelValue
}

// eslint-disable-next-line import/no-mutable-exports
export let collectedLogs: {[key: string]: string[]} = {}

/**
 * This is only used during UnitTesting.
 * If we are in a testing context, instead of printing the logs to the console,
 * we will store them in a variable that can be accessed from the tests.
 * @param key {string} The key of the log.
 * @param content {string} The content of the log.
 */
const collectLog = (key: string, content: Message) => {
  const output = collectedLogs.output ?? []
  const data = collectedLogs[key] ?? []
  data.push(stripAnsi(stringifyMessage(content) ?? ''))
  output.push(stripAnsi(stringifyMessage(content) ?? ''))
  collectedLogs[key] = data
  collectedLogs.output = output
}

export const clearCollectedLogs = () => {
  collectedLogs = {}
}

/**
 * Ouputs information to the user.
 * Info messages don't get additional formatting.
 * Note: Info messages are sent through the standard output.
 * @param content {string} The content to be output to the user.
 * @param logger {Function} The logging function to use to output to the user.
 */
export const info = (content: Message, logger: Logger = consoleLog) => {
  const message = stringifyMessage(content)
  if (isUnitTest()) collectLog('info', content)
  outputWhereAppropriate('info', logger, message)
}

/**
 * Outputs a success message to the user.
 * Success messages receive a special formatting to make them stand out in the console.
 * Note: Success messages are sent through the standard output.
 * @param content {string} The content to be output to the user.
 * @param logger {Function} The logging function to use to output to the user.
 */
export const success = (content: Message, logger: Logger = consoleLog) => {
  const message = colors.bold(`✅ Success! ${stringifyMessage(content)}.`)
  if (isUnitTest()) collectLog('success', content)
  outputWhereAppropriate('info', logger, message)
}

/**
 * Outputs a completed message to the user.
 * Completed message receive a special formatting to make them stand out in the console.
 * Note: Completed messages are sent through the standard output.
 * @param content {string} The content to be output to the user.
 * @param logger {Function} The logging function to use to output to the user.
 */
export const completed = (content: Message, logger: Logger = consoleLog) => {
  const message = `${colors.green('✔')} ${stringifyMessage(content)}`
  if (isUnitTest()) collectLog('completed', content)
  outputWhereAppropriate('info', logger, message)
}

/**
 * Ouputs debug information to the user. By default these output is hidden unless the user calls the CLI with --verbose.
 * Debug messages don't get additional formatting.
 * Note: Debug messages are sent through the standard output.
 * @param content {string} The content to be output to the user.
 * @param logger {Function} The logging function to use to output to the user.
 */
export const debug = (content: Message, logger: Logger = consoleLog) => {
  if (isUnitTest()) collectLog('debug', content)
  const message = colors.gray(stringifyMessage(content))
  outputWhereAppropriate('debug', logger, message)
}

/**
 * Outputs a warning message to the user.
 * Warning messages receive a special formatting to make them stand out in the console.
 * Note: Warning messages are sent through the standard output.
 * @param content {string} The content to be output to the user.
 * @param logger {Function} The logging function to use to output to the user.
 */
export const warn = (content: Message, logger: Logger = consoleWarn) => {
  if (isUnitTest()) collectLog('warn', content)
  const message = colors.yellow(stringifyMessage(content))
  outputWhereAppropriate('warn', logger, message)
}

/**
 * Prints a new line in the terminal.
 */
export const newline = () => {
  console.log()
}

/**
 * Formats and outputs a fatal error.
 * Note: This API is not intended to be used internally. If you want to
 * abort the execution due to an error, raise a fatal error and let the
 * error handler handle and format it.
 * @param content {Fatal} The fatal error to be output.
 */
export const error = async (content: Fatal) => {
  if (!content.message) {
    return
  }
  let outputString = ''
  const message = content.message
  const padding = '    '
  const header = colors.redBright(`\n━━━━━━ Error ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
  const footer = colors.redBright('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  outputString += header
  const lines = message.split('\n')
  for (const line of lines) {
    outputString += `${padding}${line}\n`
  }
  if (content.tryMessage) {
    outputString += `\n${padding}${colors.bold('What to try:')}\n`
    const lines = content.tryMessage.split('\n')
    for (const line of lines) {
      outputString += `${padding}${line}\n`
    }
  }

  let stack = new StackTracey(content)
  stack.items.forEach((item) => {
    item.file = cleanSingleStackTracePath(item.file)
  })

  stack = await stack.withSourcesAsync()
  stack = stack
    .filter((entry) => {
      return !entry.file.includes('@oclif/core')
    })
    .map((item) => {
      item.calleeShort = colors.yellow(item.calleeShort)
      /** We make the paths relative to the packages/ directory */
      const fileShortComponents = item.fileShort.split('packages/')
      item.fileShort = fileShortComponents.length === 2 ? fileShortComponents[1]! : fileShortComponents[0]!
      return item
    })
  if (content instanceof Bug) {
    if (stack.items.length !== 0) {
      outputString += `\n${padding}${colors.bold('Stack trace:')}\n`
      const stackLines = stack.asTable({}).split('\n')
      for (const stackLine of stackLines) {
        outputString += `${padding}${stackLine}\n`
      }
    }
  }
  outputString += footer
  outputWhereAppropriate('error', consoleError, outputString)
}

export function stringifyMessage(message: Message): string {
  if (message instanceof TokenizedString) {
    return message.value
  } else {
    return message
  }
}

const message = (content: Message, level: LogLevel = 'info') => {
  const stringifiedMessage = stringifyMessage(content)
  outputWhereAppropriate(level, consoleLog, stringifiedMessage)
}

export interface OutputProcess {
  /** The prefix to include in the logs
   *   [vite] Output coming from Vite
   */
  prefix: string
  /**
   * A callback to invoke the process. stdout and stderr should be used
   * to send standard output and error data that gets formatted with the
   * right prefix.
   */
  action: (stdout: Writable, stderr: Writable, signal: AbortSignal) => Promise<void>
}

/**
 * Use this function when you have multiple concurrent processes that send data events
 * and we need to output them ensuring that they can visually differenciated by the user.
 *
 * @param processes {OutputProcess[]} A list of processes to run concurrently.
 */
export async function concurrent(
  processes: OutputProcess[],
  callback: ((signal: AbortSignal) => void) | undefined = undefined,
) {
  const abortController = new AbortController()

  // eslint-disable-next-line node/callback-return
  if (callback) callback(abortController.signal)

  const concurrentColors = [token.yellow, token.cyan, token.magenta, token.green]
  const prefixColumnSize = Math.max(...processes.map((process) => process.prefix.length))

  function linePrefix(prefix: string, index: number) {
    const colorIndex = index < concurrentColors.length ? index : index % concurrentColors.length
    const color = concurrentColors[colorIndex]!
    return color(`${prefix}${' '.repeat(prefixColumnSize - prefix.length)} ${colors.bold('|')} `)
  }

  try {
    await Promise.all(
      processes.map(async (process, index) => {
        const stdout = new Writable({
          write(chunk, _encoding, next) {
            const lines = stripAnsiEraseCursorEscapeCharacters(chunk.toString('ascii')).split(/\n/)
            for (const line of lines) {
              info(content`${linePrefix(process.prefix, index)}${line}`)
            }
            next()
          },
        })
        const stderr = new Writable({
          write(chunk, _encoding, next) {
            const lines = stripAnsiEraseCursorEscapeCharacters(chunk.toString('ascii')).split(/\n/)
            for (const line of lines) {
              message(content`${linePrefix(process.prefix, index)}${colors.bold(line)}`, 'error')
            }
            next()
          },
        })
        await process.action(stdout, stderr, abortController.signal)
      }),
    )
  } catch (_error) {
    // We abort any running process
    abortController.abort()
    throw _error
  }
}

/**
 * This regex can be used to find the erase cursor Ansii characters
 * to strip them from the string.
 * https://gist.github.com/fnky/458719343aabd01cfb17a3a4f7296797#erase-functions
 */
const eraseCursorAnsiRegex = [
  // Erase the entire line
  '2K',
  // Clear vertical tab stop at current line
  '1G',
]
  .map((element) => `[\\u001B\\u009B][[\\]()#;?]*${element}`)
  .join('|')

/**
 * The data sent through the standard pipelines of the sub-processes that we execute
 * might contain ansii escape characters to move the cursor. That causes any additional
 * formatting to break. This function takes a string and strips escape characters that
 * manage the cursor in the terminal.
 * @param value {string} String whose erase cursor escape characters will be stripped.
 * @returns {string} Stripped string.
 */
function stripAnsiEraseCursorEscapeCharacters(value: string): string {
  return value.replace(/(\n)$/, '').replace(new RegExp(eraseCursorAnsiRegex, 'g'), '')
}

function consoleLog(message: string): void {
  console.log(withOrWithoutStyle(message))
}

function consoleError(message: string): void {
  console.error(withOrWithoutStyle(message))
}

function consoleWarn(message: string): void {
  console.warn(withOrWithoutStyle(message))
}

function outputWhereAppropriate(logLevel: LogLevel, logger: Logger, message: string): void {
  if (shouldOutput(logLevel)) {
    logger(message)
  }
  logToFile(message, logLevel.toUpperCase())
}

export function logFileExists(): boolean {
  return Boolean(logFileStream)
}

// DO NOT USE THIS FUNCTION DIRECTLY under normal circumstances.
// It is exported purely for use in cases where output is already being logged
// to the terminal but is not reflected in the logfile, e.g. Listr output.
export function logToFile(message: string, logLevel: string): void {
  // If file logging hasn't been initiated, skip it
  if (!logFileExists()) return
  const timestamp = new Date().toISOString()
  const logContents = `[${timestamp} ${commandUuid} ${logLevel}]: ${message}\n`
  logFileStream.write(logContents)
}

function withOrWithoutStyle(message: string): string {
  if (shouldDisplayColors()) {
    return message
  } else {
    return unstyled(message)
  }
}

export function unstyled(message: string): string {
  return colors.unstyle(message)
}

export function shouldDisplayColors(): boolean {
  return Boolean(process.stdout.isTTY || process.env.FORCE_COLOR)
}

export async function pageLogs({lastCommand}: {lastCommand: boolean}) {
  const logDir = constants.paths.directories.cache.path()
  const logFile = pathJoin(logDir, logFileName)
  // Ensure file exists in case they deleted it or something
  fileTouchSync(logFile)
  if (lastCommand) {
    printLastCommand(logFile)
  } else {
    await page(logFile)
  }
}

function printLastCommand(logFile: string): void {
  const contents = fileReadSync(logFile).split('\n')
  const uuids = contents
    .map(logfileLineUUID)
    .filter((uuid) => uuid)
    .reverse()
  // 2nd unique UUID, because the currently running command will be the 1st
  const relevantUuid = Array.from(new Set(uuids))[1]
  if (relevantUuid) {
    consoleLog(relevantLines(contents, relevantUuid).join('\n'))
  }
}

function relevantLines(contents: string[], relevantUuid: string): string[] {
  // We run through the file line by line, keeping track of the most recently
  // encountered UUID.
  //
  // If the current line has a UUID, it's a new logged unit and should be
  // considered. Otherwise, the line is related to the most recent UUID.
  let mostRecentUuid = ''
  return contents.filter((line: string) => {
    const currentUuid = logfileLineUUID(line) || mostRecentUuid
    mostRecentUuid = currentUuid
    return currentUuid === relevantUuid
  })
}

function logfileLineUUID(line: string): string | null {
  // Log lines look like:
  //
  //         timestamp                        UUID                               contents
  // ===========================================================================================
  // [2022-07-20T08:51:40.296Z 5288e1da-a06a-4f96-b1a6-e34fcdd7b416 DEBUG]: Running command logs
  // ===========================================================================================
  //
  // There may be subsequent lines if the contents section is multi-line.
  //
  const match = line.match(/^\[\S+ ([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}) [A-Z]+\]/)
  return match && match[1]!
}

/**
 *
 * @param packageManager {PackageManager} The package manager that is being used.
 * @param version {string} The version to update to
 * @returns {te}
 */
export function getOutputUpdateCLIReminder(packageManager: PackageManager, version: string): string {
  const updateCommand = token.packagejsonScript(packageManager, 'shopify', 'upgrade')
  return content`💡 Version ${version} available! Run ${updateCommand}`.value
}

/* eslint-enable no-console */
