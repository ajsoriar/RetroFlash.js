/* RetroFlash.js - AVM1 variables: scope chains, target paths, and text fields bound to a variable. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var UNKNOWN_VALUE = M.UNKNOWN_VALUE, toAvmString = M.toAvmString, isClip = M.isClip, isObject = M.isObject,
    getMember = M.getMember, hasMember = M.hasMember, setMember = M.setMember, setOwn = M.setOwn;

  /* A script resolves names through its context `ctx`: { rt (the movie's runtime), version, scopes, root,
     thisValue }. `scopes` lists the scope chain from the bottom: { kind, obj } with kind 'global' (the global
     object), 'target' (the timeline the script addresses: its own, or the SetTarget target), 'local' (a
     function's locals) or 'with' (a with block's object). Plain names are looked up from the top; a plain
     SetVariable sets the first scope that has the name, or the target timeline. Timeline variables live in
     Clip.variables (names lowercased before SWF 7, when they are case-insensitive). */

  function keyOf(clip, name) { return clip.env.version < 7 ? name.toLowerCase() : name; }
  function isContainer(v) { return isClip(v) || isObject(v); }
  // Rightmost variable separator: ':' always, '.' from SWF 5 (or always, for SetVariable and text fields).
  function separatorIndex(path, dots) {
    return Math.max(path.lastIndexOf(':'), dots ? path.lastIndexOf('.') : -1);
  }
  // A runtime for path steps outside scripts (text field bindings): members of clips only.
  function plainRuntime(version) { return { version: version, protos: {} }; }

  /* Resolves a target path from `start` (a clip or an object): slash syntax ("/a/b", "../a", "a/b"), dot syntax
     ("_root.a", "_parent.b", "this.a"; from SWF 5) and ':' steps (from SWF 5). A step names a child sprite
     instance first, then a member holding a clip or an object; "_root", "_parent", "_level0", "_global" and,
     with ctx, "this" are understood. Returns the clip or object, null when the path leads nowhere, or
     UNKNOWN_VALUE when a step reaches a value that is not known. */
  function resolvePath(start, path, version, ctx) {
    var rt = ctx ? ctx.rt : plainRuntime(version), root = ctx ? ctx.root : start.root ? start.root() : null;
    var current = start, swf5 = version >= 5, slash = false, first = true;
    if (path.charAt(0) === '/') { if (!root) return null; current = root; path = path.slice(1); slash = true; first = false; }
    while (path) {
      if (swf5) path = path.replace(/^:+/, '');
      if (path === '..' || path.slice(0, 3) === '../' || (swf5 && path.slice(0, 3) === '..:')) {
        if (path.charAt(2) === '/') slash = true;
        path = path.slice(3);
        current = isClip(current) ? current.parent : null;
        if (!current) return null;
        first = false;
        continue;
      }
      var end = 0;
      for (; end < path.length; end++) {
        var c = path.charAt(end);
        if (c === '/') { slash = true; break; }
        if (swf5 && (c === ':' || (c === '.' && !slash))) break;
      }
      var name = path.slice(0, end), lower = name.toLowerCase(), next = null;
      path = path.slice(end + 1);
      if (swf5 && lower === 'this') next = ctx ? ctx.thisValue : current;
      else if (lower === '_root' || (first && lower === '_level0')) next = root;
      else if (first && lower === '_global' && ctx) next = rt.global;
      else if (lower === '_parent') next = isClip(current) ? current.parent : getMember(rt, current, name);
      else {
        if (isClip(current)) next = current.childByName(name);
        if (!next) next = getMember(rt, current, name);
      }
      if (next === UNKNOWN_VALUE) return UNKNOWN_VALUE;
      if (!isContainer(next)) return null;
      current = next;
      first = false;
    }
    return current;
  }
  // A target path from a clip to a Clip or null, for SetTarget.
  function resolveTarget(clip, path) {
    var found = resolvePath(clip, path, clip.env.version);
    return isClip(found) ? found : null;
  }

  // The value of a reference to `clip`, read in a movie of `version`: a clip reads as undefined in SWF 4.
  function clipValue(clip, version) { return version < 5 ? undefined : clip; }

  /* A plain name through the scope chain: { value, owner } (owner: the scope object that had it, or null).
     "this" is the script's `this` from SWF 5; "_level0" is the root. */
  function lookupName(ctx, name) {
    var version = ctx.version, lower = name.toLowerCase();
    if (version >= 5 && (version < 7 ? lower === 'this' : name === 'this')) return { value: ctx.thisValue, owner: null };
    for (var i = ctx.scopes.length - 1; i >= 0; i--) {
      var obj = ctx.scopes[i].obj;
      if (hasMember(ctx.rt, obj, name)) {
        var value = getMember(ctx.rt, obj, name);
        return { value: isClip(value) ? clipValue(value, version) : value, owner: obj };
      }
    }
    if (lower === '_level0') return { value: clipValue(ctx.root, version), owner: null };
    return { value: undefined, owner: null };
  }
  /* GetVariable: "path:name" or "path.name" reads a member of what the path names, trying the path from each
     scope from the top; a slash path without a variable names a timeline (SWF 5+); otherwise a plain name. */
  function getVariable(ctx, path) {
    return lookupVariable(ctx, path).value;
  }
  // GetVariable with the object the value was found on ({ value, owner }), for CallFunction's `this`.
  function lookupVariable(ctx, path) {
    var version = ctx.version, at = separatorIndex(path, version >= 5), i, owner;
    if (at >= 0) {
      if (at === 0) return { value: undefined, owner: null };
      var name = path.slice(at + 1);
      for (i = ctx.scopes.length - 1; i >= 0; i--) {
        owner = resolvePath(ctx.scopes[i].obj, path.slice(0, at), version, ctx);
        if (owner === UNKNOWN_VALUE) return { value: UNKNOWN_VALUE, owner: null };
        if (owner && hasMember(ctx.rt, owner, name)) return { value: getMember(ctx.rt, owner, name), owner: owner };
      }
      return { value: undefined, owner: null };
    }
    if (version >= 5 && path.indexOf('/') >= 0) {
      for (i = ctx.scopes.length - 1; i >= 0; i--) {
        var target = resolvePath(ctx.scopes[i].obj, path, version, ctx);
        if (target === UNKNOWN_VALUE) return { value: UNKNOWN_VALUE, owner: null };
        if (target) return { value: isClip(target) ? clipValue(target, version) : target, owner: null };
      }
    }
    return lookupName(ctx, path);
  }
  /* SetVariable: "path:name" and "path.name" set a member of what the path names (tried from each scope from
     the top; nothing is set when no scope resolves it, as in Flash Player); a plain name is set on the first
     scope that has it, or on the target timeline. Returns false when nothing could be set: _root or _parent,
     or a path through a value that is not known. */
  function setVariable(ctx, path, value) {
    var version = ctx.version, i;
    if (path === '' || (version >= 5 && path === 'this')) return true;
    var at = separatorIndex(path, true);
    if (at >= 0) {
      for (i = ctx.scopes.length - 1; i >= 0; i--) {
        var owner = resolvePath(ctx.scopes[i].obj, path.slice(0, at), version, ctx);
        if (owner === UNKNOWN_VALUE) return false;
        if (owner) return setMember(ctx.rt, owner, path.slice(at + 1), value);
      }
      return true;
    }
    for (i = ctx.scopes.length - 1; i >= 0; i--) {
      var scope = ctx.scopes[i];
      if (scope.kind === 'target' || scope.kind === 'global' || hasMember(ctx.rt, scope.obj, path)) return setMember(ctx.rt, scope.obj, path, value);
    }
    return true;
  }
  // Whether the script runs in a function (a local scope above the target timeline).
  function inLocalScope(ctx) {
    for (var i = ctx.scopes.length - 1; i >= 0; i--) {
      if (ctx.scopes[i].kind === 'local') return true;
      if (ctx.scopes[i].kind === 'target') return false;
    }
    return false;
  }
  /* DefineLocal: in a function, the name becomes a local; outside, a path sets like SetVariable and a plain
     name is set on the timeline. With `onlyIfMissing` (DefineLocal2), an existing variable is left alone. */
  function defineLocal(ctx, name, value, onlyIfMissing) {
    if (!inLocalScope(ctx) && separatorIndex(name, true) >= 0) {
      if (onlyIfMissing && getVariable(ctx, name) !== undefined) return true;
      return setVariable(ctx, name, value);
    }
    for (var i = ctx.scopes.length - 1; i >= 0; i--) {
      var scope = ctx.scopes[i];
      if (scope.kind === 'with' || !scope.obj) continue;
      if (onlyIfMissing && hasMember(ctx.rt, scope.obj, name)) return true;
      if (isClip(scope.obj)) return setMember(ctx.rt, scope.obj, name, value);
      setOwn(scope.obj, name, value, ctx.version);
      return true;
    }
    return true;
  }
  // delete name (Delete2): a member of what a path names, or the first scope that has a plain name.
  function deleteVariable(ctx, path) {
    var at = separatorIndex(path, true);
    if (at >= 0) {
      var owner = getVariable(ctx, path.slice(0, at));
      return isContainer(owner) ? M.deleteMember(ctx.rt, owner, path.slice(at + 1)) : false;
    }
    for (var i = ctx.scopes.length - 1; i >= 0; i--) {
      if (hasMember(ctx.rt, ctx.scopes[i].obj, path)) return M.deleteMember(ctx.rt, ctx.scopes[i].obj, path);
    }
    return false;
  }

  /* Text fields bound to a variable (DefineEditText VariableName), on the timeline that holds the field (or
     another one, through a path). When the field is created, an existing variable gives the field its text;
     otherwise non-empty initial text becomes the variable's value. Afterwards the field shows the variable's
     current value; while the variable does not exist or is unknown, it keeps its last text. */
  function bindingOwner(binding) {
    var path = binding.path, at = separatorIndex(path, true);
    if (at < 0) return { clip: binding.clip, key: keyOf(binding.clip, path) };
    var owner = resolvePath(binding.clip, path.slice(0, at), binding.version);
    return isClip(owner) ? { clip: owner, key: keyOf(owner, path.slice(at + 1)) } : null;
  }
  function bindTextField(clip, obj) {
    var field = obj.character.field;
    var binding = obj.binding = { clip: clip, path: field.variableName, version: obj.character.version, text: field.initialText || '' };
    var owner = bindingOwner(binding);
    if (!owner) return;
    if (owner.clip.variables.has(owner.key)) textFieldText(obj);
    else if (binding.text) owner.clip.variables.set(owner.key, binding.text);
  }
  // The text a bound field shows now (HTML source for HTML fields).
  function textFieldText(obj) {
    var binding = obj.binding, owner = bindingOwner(binding);
    if (owner && owner.clip.variables.has(owner.key)) {
      var value = owner.clip.variables.get(owner.key);
      if (value !== UNKNOWN_VALUE) binding.text = toAvmString(value, binding.version);
    }
    return binding.text;
  }

  Object.assign(M, {
    resolvePath: resolvePath, resolveTarget: resolveTarget, getVariable: getVariable, lookupVariable: lookupVariable,
    setVariable: setVariable, defineLocal: defineLocal, deleteVariable: deleteVariable,
    bindTextField: bindTextField, textFieldText: textFieldText
  });
})(typeof window !== 'undefined' ? window : globalThis);
