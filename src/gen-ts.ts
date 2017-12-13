/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt The complete set of authors may be found
 * at http://polymer.github.io/AUTHORS.txt The complete set of contributors may
 * be found at http://polymer.github.io/CONTRIBUTORS.txt Code distributed by
 * Google as part of the polymer project is also subject to an additional IP
 * rights grant found at http://polymer.github.io/PATENTS.txt
 */

import * as minimatch from 'minimatch';
import * as path from 'path';
import * as analyzer from 'polymer-analyzer';
import {Function as AnalyzerFunction} from 'polymer-analyzer/lib/javascript/function';

import {closureParamToTypeScript, closureTypeToTypeScript} from './closure-types';
import * as ts from './ts-ast';

/**
 * Configuration for declaration generation.
 */
export interface Config {
  /**
   * Skip source files whose paths match any of these glob patterns. If
   * undefined, defaults to excluding directories ending in "test" or "demo".
   */
  exclude?: string[];

  /**
   * Remove any triple-slash references to these files, specified as paths
   * relative to the analysis root directory.
   */
  removeReferences?: string[];

  /**
   * Additional files to insert as triple-slash reference statements. Given the
   * map `a: b[]`, a will get an additional reference statement for each file
   * path in b. All paths are relative to the analysis root directory.
   */
  addReferences?: {[filepath: string]: string[]};
}

/**
 * Analyze all files in the given directory using Polymer Analyzer, and return
 * TypeScript declaration document strings in a map keyed by relative path.
 */
export async function generateDeclarations(
    rootDir: string, config: Config): Promise<Map<string, string>> {
  const a = new analyzer.Analyzer({
    urlLoader: new analyzer.FSUrlLoader(rootDir),
    urlResolver: new analyzer.PackageUrlResolver(),
  });
  const analysis = await a.analyzePackage();
  const outFiles = new Map<string, string>();
  for (const tsDoc of analyzerToAst(analysis, config, rootDir)) {
    outFiles.set(tsDoc.path, tsDoc.serialize())
  }
  return outFiles;
}

/**
 * Make TypeScript declaration documents from the given Polymer Analyzer
 * result.
 */
function analyzerToAst(
    analysis: analyzer.Analysis, config: Config, rootDir: string):
    ts.Document[] {
  const exclude = (config.exclude || ['test/**', 'demo/**'])
                      .map((p) => new minimatch.Minimatch(p));
  const addReferences = config.addReferences || {};
  const removeReferencesResolved = new Set(
      (config.removeReferences || []).map((r) => path.resolve(rootDir, r)));

  // Analyzer can produce multiple JS documents with the same URL (e.g. an
  // HTML file with multiple inline scripts). We also might have multiple
  // files with the same basename (e.g. `foo.html` with an inline script,
  // and `foo.js`). We want to produce one declarations file for each
  // basename, so we first group Analyzer documents by their declarations
  // filename.
  const declarationDocs = new Map<string, analyzer.Document[]>();
  for (const jsDoc of analysis.getFeatures({kind: 'js-document'})) {
    if (exclude.some((r) => r.match(jsDoc.url))) {
      continue;
    }
    const filename = makeDeclarationsFilename(jsDoc.url);
    let docs = declarationDocs.get(filename);
    if (!docs) {
      docs = [];
      declarationDocs.set(filename, docs);
    }
    docs.push(jsDoc);
  }

  const tsDocs = [];
  for (const [declarationsFilename, analyzerDocs] of declarationDocs) {
    const tsDoc = new ts.Document({
      path: declarationsFilename,
      header: makeHeader(analyzerDocs.map((d) => d.url)),
    });
    for (const analyzerDoc of analyzerDocs) {
      handleDocument(analyzerDoc, tsDoc);
    }
    for (const ref of tsDoc.referencePaths) {
      const resolvedRef = path.resolve(rootDir, path.dirname(tsDoc.path), ref);
      if (removeReferencesResolved.has(resolvedRef)) {
        tsDoc.referencePaths.delete(ref);
      }
    }
    for (const ref of addReferences[tsDoc.path] || []) {
      tsDoc.referencePaths.add(path.relative(path.dirname(tsDoc.path), ref));
    }
    tsDoc.simplify();
    // Include even documents with no members. They might be dependencies of
    // other files via the HTML import graph, and it's simpler to have empty
    // files than to try and prune the references (especially across packages).
    tsDocs.push(tsDoc);
  }
  return tsDocs;
}

/**
 * Create a TypeScript declarations filename for the given source document URL.
 * Simply replaces the file extension with `d.ts`.
 */
function makeDeclarationsFilename(sourceUrl: string): string {
  const parsed = path.parse(sourceUrl);
  return path.join(parsed.dir, parsed.name) + '.d.ts';
}

/**
 * Generate the header comment to show at the top of a declarations document.
 */
function makeHeader(sourceUrls: string[]): string {
  return `DO NOT EDIT

This file was automatically generated by
  https://github.com/Polymer/gen-typescript-declarations

To modify these typings, edit the source file(s):
${sourceUrls.map((url) => '  ' + url).join('\n')}`;
}

interface MaybePrivate {
  privacy?: 'public'|'private'|'protected'
}

/**
 * Extend the given TypeScript declarations document with all of the relevant
 * items in the given Polymer Analyzer document.
 */
function handleDocument(doc: analyzer.Document, root: ts.Document) {
  for (const feature of doc.getFeatures()) {
    if ((feature as MaybePrivate).privacy === 'private') {
      continue;
    }
    if (feature.kinds.has('element')) {
      handleElement(feature as analyzer.Element, root);
    } else if (feature.kinds.has('behavior')) {
      handleBehavior(feature as analyzer.PolymerBehavior, root);
    } else if (feature.kinds.has('element-mixin')) {
      handleMixin(feature as analyzer.ElementMixin, root);
    } else if (feature.kinds.has('class')) {
      handleClass(feature as analyzer.Class, root);
    } else if (feature.kinds.has('function')) {
      handleFunction(feature as AnalyzerFunction, root);
    } else if (feature.kinds.has('namespace')) {
      handleNamespace(feature as analyzer.Namespace, root);
    } else if (feature.kinds.has('import')) {
      // Sometimes an Analyzer document includes an import feature that is
      // inbound (things that depend on me) instead of outbound (things I
      // depend on). For example, if an HTML file has a <script> tag for a JS
      // file, then the JS file's Analyzer document will include that <script>
      // tag as an import feature. We only care about outbound dependencies,
      // hence this check.
      if (feature.sourceRange && feature.sourceRange.file === doc.url) {
        handleImport(feature as analyzer.Import, root);
      }
    }
  }
}

/**
 * Add the given Element to the given TypeScript declarations document.
 */
function handleElement(feature: analyzer.Element, root: ts.Document) {
  // Whether this element has a constructor that is assigned and can be called.
  // If it does we'll emit a class, otherwise an interface.
  let constructable;

  let fullName;   // Fully qualified reference, e.g. `Polymer.DomModule`.
  let shortName;  // Just the last part of the name, e.g. `DomModule`.
  let parent;     // Where in the namespace tree does this live.

  if (feature.className) {
    constructable = true;
    let namespacePath;
    [namespacePath, shortName] = splitReference(feature.className);
    fullName = feature.className;
    parent = findOrCreateNamespace(root, namespacePath);

  } else if (feature.tagName) {
    constructable = false;
    shortName = kebabToCamel(feature.tagName);
    fullName = shortName;
    // We're going to pollute the global scope with an interface.
    parent = root;

  } else {
    console.error('Could not find a name.');
    return;
  }

  if (constructable) {
    // TODO How do we handle behaviors with classes?
    const c = new ts.Class({
      name: shortName,
      description: feature.description || feature.summary,
      extends: (feature.extends) ||
          (isPolymerElement(feature) ? 'Polymer.Element' : 'HTMLElement'),
      mixins: feature.mixins.map((mixin) => mixin.identifier),
      properties: handleProperties(feature.properties.values()),
      methods: handleMethods(feature.methods.values()),
    });
    parent.members.push(c);

  } else {
    // TODO How do we handle mixins when we are emitting an interface? We don't
    // currently define interfaces for mixins, so we can't just add them to
    // extends.
    const i = new ts.Interface({
      name: shortName,
      description: feature.description || feature.summary,
      properties: handleProperties(feature.properties.values()),
      methods: handleMethods(feature.methods.values()),
    });

    if (isPolymerElement(feature)) {
      i.extends.push('Polymer.Element');
      i.extends.push(...feature.behaviorAssignments.map(
          (behavior) => behavior.name));
    }

    parent.members.push(i);
  }

  // The `HTMLElementTagNameMap` global interface maps custom element tag names
  // to their definitions, so that TypeScript knows that e.g.
  // `dom.createElement('my-foo')` returns a `MyFoo`. Augment the map with this
  // custom element.
  if (feature.tagName) {
    const elementMap = findOrCreateInterface(root, 'HTMLElementTagNameMap');
    elementMap.properties.push(new ts.Property({
      name: feature.tagName,
      type: new ts.NameType(fullName),
    }));
  }
}

/**
 * Add the given Polymer Behavior to the given TypeScript declarations
 * document.
 */
function handleBehavior(feature: analyzer.PolymerBehavior, root: ts.Document) {
  if (!feature.className) {
    console.error('Could not find a name for behavior.');
    return;
  }
  const [namespacePath, className] = splitReference(feature.className);
  const i = new ts.Interface({name: className});
  i.description = feature.description || feature.summary;
  i.properties = handleProperties(feature.properties.values());
  i.methods = handleMethods(feature.methods.values());
  findOrCreateNamespace(root, namespacePath).members.push(i);
}

/**
 * Add the given Mixin to the given TypeScript declarations document.
 */
function handleMixin(feature: analyzer.ElementMixin, root: ts.Document) {
  const [namespacePath, name] = splitReference(feature.name);
  const namespace_ = findOrCreateNamespace(root, namespacePath);

  // We represent mixins in two parts: a mixin function that is called to
  // augment a given class with this mixin, and an interface with the
  // properties and methods that are added by this mixin. We can use the same
  // name for both parts because one is in value space, and the other is in
  // type space.

  const function_ = new ts.Mixin({name});
  function_.description = feature.description;
  function_.interfaces = [name, ...feature.mixins.map((m) => m.identifier)];
  namespace_.members.push(function_);

  const interface_ = new ts.Interface({name});
  interface_.properties = handleProperties(feature.properties.values());
  interface_.methods = handleMethods(feature.methods.values());
  namespace_.members.push(interface_);
}

/**
 * Add the given Class to the given TypeScript declarations document.
 */
function handleClass(feature: analyzer.Class, root: ts.Document) {
  if (!feature.className) {
    console.error('Could not find a name for class.');
    return;
  }
  const [namespacePath, name] = splitReference(feature.className);
  const m = new ts.Class({name});
  m.description = feature.description;
  m.properties = handleProperties(feature.properties.values());
  m.methods = handleMethods(feature.methods.values());
  findOrCreateNamespace(root, namespacePath).members.push(m);
}


/**
 * Add the given Function to the given TypeScript declarations document.
 */
function handleFunction(feature: AnalyzerFunction, root: ts.Document) {
  const [namespacePath, name] = splitReference(feature.name);

  const f = new ts.Function({
    name,
    description: feature.description || feature.summary,
    templateTypes: feature.templateTypes,
    returns: closureTypeToTypeScript(
        feature.return && feature.return.type, feature.templateTypes),
    returnsDescription: feature.return && feature.return.desc
  });

  for (const param of feature.params || []) {
    // TODO Handle parameter default values. Requires support from Analyzer
    // which only handles this for class method parameters currently.
    const {type, optional, rest} =
        closureParamToTypeScript(param.type, feature.templateTypes);
    f.params.push(new ts.Param({name: param.name, type, optional, rest}));
  }

  findOrCreateNamespace(root, namespacePath).members.push(f);
}

/**
 * Convert the given Analyzer properties to their TypeScript declaration
 * equivalent.
 */
function handleProperties(analyzerProperties: Iterable<analyzer.Property>):
    ts.Property[] {
  const tsProperties = <ts.Property[]>[];
  for (const property of analyzerProperties) {
    if (property.inheritedFrom || property.privacy === 'private') {
      continue;
    }
    const p = new ts.Property({
      name: property.name,
      // TODO If this is a Polymer property with no default value, then the
      // type should really be `<type>|undefined`.
      type: closureTypeToTypeScript(property.type),
    });
    p.description = property.description || '';
    tsProperties.push(p);
  }
  return tsProperties;
}


/**
 * Convert the given Analyzer methods to their TypeScript declaration
 * equivalent.
 */
function handleMethods(analyzerMethods: Iterable<analyzer.Method>):
    ts.Method[] {
  const tsMethods = <ts.Method[]>[];
  for (const method of analyzerMethods) {
    if (method.inheritedFrom || method.privacy === 'private') {
      continue;
    }
    const m = new ts.Method({
      name: method.name,
      returns: closureTypeToTypeScript(method.return && method.return.type),
      returnsDescription: method.return && method.return.desc
    });
    m.description = method.description || '';

    let requiredAhead = false;
    for (const param of reverseIter(method.params || [])) {
      let {type, optional, rest} = closureParamToTypeScript(param.type);

      if (param.defaultValue !== undefined) {
        // Parameters with default values generally behave like optional
        // parameters. However, unlike optional parameters, they may be
        // followed by a required parameter, in which case the default value is
        // set by explicitly passing undefined.
        if (!requiredAhead) {
          optional = true;
        } else {
          type = new ts.UnionType([type, ts.undefinedType]);
        }
      } else if (!optional) {
        requiredAhead = true;
      }

      // Analyzer might know this is a rest parameter even if there was no
      // JSDoc type annotation (or if it was wrong).
      rest = rest || !!param.rest;
      if (rest && type.kind !== 'array') {
        // Closure rest parameter types are written without the Array syntax,
        // but in TypeScript they must be explicitly arrays.
        type = new ts.ArrayType(type);
      }

      m.params.unshift(new ts.Param({
        name: param.name,
        description: param.description,
        type,
        optional,
        rest
      }));
    }

    tsMethods.push(m);
  }
  return tsMethods;
}

/**
 * Iterate over an array backwards.
 */
function* reverseIter<T>(arr: T[]) {
  for (let i = arr.length - 1; i >= 0; i--) {
    yield arr[i];
  }
}

/**
 * Add the given namespace to the given TypeScript declarations document.
 */
function handleNamespace(feature: analyzer.Namespace, tsDoc: ts.Document) {
  const ns = findOrCreateNamespace(tsDoc, feature.name.split('.'));
  if (ns.kind === 'namespace') {
    ns.description = feature.description || feature.summary || '';
  }
}

/**
 * Add an HTML import to a TypeScript declarations file. For a given HTML
 * import, we assume there is a corresponding declarations file that was
 * generated by this same process.
 *
 * TODO If the import was to an external package, we currently don't know if
 * the typings file actually exists. Also, if we end up placing type
 * declarations in a types/ subdirectory, we will need to update these paths to
 * match.
 */
function handleImport(feature: analyzer.Import, tsDoc: ts.Document) {
  if (!feature.url) {
    return;
  }
  // When we analyze a package's Git repo, our dependencies are installed to
  // "<repo>/bower_components". However, when this package is itself installed
  // as a dependency, our own dependencies will instead be siblings, one
  // directory up the tree.
  //
  // Analyzer (since 2.5.0) will set an import feature's URL to the resolved
  // dependency path as discovered on disk. An import for "../foo/foo.html"
  // will be resolved to "bower_components/foo/foo.html". Transform the URL
  // back to the style that will work when this package is installed as a
  // dependency.
  const url = feature.url.replace(/^(bower_components|node_modules)\//, '../');
  tsDoc.referencePaths.add(
      path.relative(path.dirname(tsDoc.path), makeDeclarationsFilename(url)));
}

/**
 * Traverse the given node to find the namespace AST node with the given path.
 * If it could not be found, add one and return it.
 */
function findOrCreateNamespace(
    root: ts.Document|ts.Namespace, path: string[]): ts.Document|ts.Namespace {
  if (!path.length) {
    return root;
  }
  let first: ts.Namespace|undefined;
  for (const member of root.members) {
    if (member.kind === 'namespace' && member.name === path[0]) {
      first = member;
      break;
    }
  }
  if (!first) {
    first = new ts.Namespace({name: path[0]});
    root.members.push(first);
  }
  return findOrCreateNamespace(first, path.slice(1));
}

/**
 * Traverse the given node to find the interface AST node with the given path.
 * If it could not be found, add one and return it.
 */
function findOrCreateInterface(
    root: ts.Document|ts.Namespace, reference: string): ts.Interface {
  const [namespacePath, name] = splitReference(reference);
  const namespace_ = findOrCreateNamespace(root, namespacePath);
  for (const member of namespace_.members) {
    if (member.kind === 'interface' && member.name === name) {
      return member;
    }
  }
  const i = new ts.Interface({name});
  namespace_.members.push(i);
  return i;
}

/**
 * Type guard that checks if a Polymer Analyzer feature is a PolymerElement.
 */
function isPolymerElement(feature: analyzer.Feature):
    feature is analyzer.PolymerElement {
  return feature.kinds.has('polymer-element');
}

/**
 * Convert kebab-case to CamelCase.
 */
function kebabToCamel(s: string): string {
  return s.replace(/(^|-)(.)/g, (_match, _p0, p1) => p1.toUpperCase());
}

/**
 * Split a reference into an array of namespace path parts, and a name part
 * (e.g. `"Foo.Bar.Baz"` => `[ ["Foo", "Bar"], "Baz" ]`).
 */
function splitReference(reference: string): [string[], string] {
  const parts = reference.split('.');
  const namespacePath = parts.slice(0, -1);
  const name = parts[parts.length - 1];
  return [namespacePath, name];
}
