/* @flow */

import { parse } from 'babylon'
import traverse from 'babel-traverse'
import generate from 'babel-generator'
import { createLoader, shouldProcess, getRelativeFilePath, FileIssue, MessageIssue } from 'pundle-api'
import type { File, FileImport, FileChunk, LoaderResult } from 'pundle-api/types'

import { getName, getParsedReplacement } from './helpers'

const RESOLVE_NAMES = new Set([
  'require',
  'require.ensure',
  'require.resolve',
  'module.hot.accept',
  'module.hot.decline',
])
const RESOLVE_NAMES_CHUNK = new Set([
  'require.ensure',
])
const RESOLVE_NAMES_SENSITIVE = new Set([
  'require',
  'require.resolve',
])

export default createLoader(function(config: Object, file: File): ?LoaderResult {
  if (!shouldProcess(this.config.rootDirectory, file.filePath, config)) {
    return null
  }

  const chunks: Array<FileChunk> = []
  const imports: Array<FileImport> = []

  let ast
  try {
    ast = parse(file.contents, {
      sourceType: 'module',
      sourceFilename: file.filePath,
      plugins: [
        'jsx',
        'flow',
        'doExpressions',
        'objectRestSpread',
        'decorators',
        'classProperties',
        'exportExtensions',
        'asyncGenerators',
        'functionBind',
        'functionSent',
        'dynamicImport',
      ],
    })
  } catch (error) {
    const errorMessage = `${error.message} in ${getRelativeFilePath(file.filePath, this.config.rootDirectory)}`
    if (error.loc) {
      throw new FileIssue(file.contents, error.loc.line, error.loc.column + 1, errorMessage, 'error')
    } else {
      throw new MessageIssue(errorMessage, 'error')
    }
  }

  const processResolve = node => {
    const request = this.getImportRequest(node.value, file.filePath)
    imports.push(request)
    node.value = request.id.toString()
    // NOTE: ^ Casting it to string is VERY VERY important, it breaks everything otherwise
  }
  const processSplit = path => {
    const chunkName = path.node.arguments[2] && path.node.arguments[2].type === 'StringLiteral' ? path.node.arguments[2].value : this.getNextUniqueID().toString()
    const chunk = {
      name: chunkName,
      entry: [],
      imports: [],
    }
    path.node.arguments[0].elements.forEach(element => {
      const request = this.getImportRequest(element.value, file.filePath)
      chunk.entry.push(request)
      element.value = request.id.toString()
    })
    if (path.node.arguments[1] && path.node.arguments[1].type === 'FunctionExpression' && path.node.arguments[1].params.length) {
      path.scope.traverse(path.node.arguments[1], {
        CallExpression: (newPath) => {
          if (newPath.node.callee.name === path.node.arguments[1].params[0].name) {
            const request = this.getImportRequest(newPath.node.arguments[0].value, file.filePath)
            chunk.imports.push(request)
            newPath.node.arguments[0].value = request.id.toString()
          }
        },
      })
    }

    chunks.push(chunk)
  }
  const processReplaceable = path => {
    const name = getName(path.node)
    if ({}.hasOwnProperty.call(this.config.replaceVariables, name)) {
      path.replaceWith(getParsedReplacement(this.config.replaceVariables[name]))
    }
  }
  traverse(ast, {
    ImportDeclaration(path) {
      processResolve(path.node.source)
    },
    CallExpression(path) {
      const name = getName(path.node.callee)
      if (!RESOLVE_NAMES.has(name)) {
        return
      }
      const parameter = path.node.arguments && path.node.arguments[0]
      if (!parameter || parameter.type !== (name === 'require.ensure' ? 'ArrayExpression' : 'StringLiteral')) {
        return
      }
      if (RESOLVE_NAMES_SENSITIVE.has(name) && path.scope.hasBinding('require')) {
        return
      }
      if (RESOLVE_NAMES_CHUNK.has(name)) {
        processSplit(path)
      } else {
        processResolve(parameter)
      }
    },
    Identifier: processReplaceable,
    MemberExpression: processReplaceable,
  })

  const compiled = generate(ast, {
    quotes: 'single',
    compact: true,
    comments: false,
    filename: file.filePath,
    sourceMaps: true,
    sourceFileName: file.filePath,
  })

  return {
    chunks,
    imports,
    contents: compiled.code,
    sourceMap: compiled.map,
  }
}, {
  extensions: ['js', 'jsx'],
})
