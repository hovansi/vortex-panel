// Trusted static archive handling. Never invoke downloaded configure/install
// scripts as root. Bounds and link checks are completed before extraction.
export const APPLICATION_RUNTIME_ARTIFACT = `import os, sys, json, stat, tarfile, pathlib, shutil
MAX_FILES = 100000
MAX_BYTES = 2147483648
def safe(name):
    value = pathlib.PurePosixPath(name)
    if not name or name.startswith('/') or '\\\\' in name or '\\x00' in name or any(p in ('..', '') for p in name.split('/')) or len(name) > 4096 or len(value.parts) > 80:
        raise ValueError('unsafe member')
    return value
def target_link(name, link):
    if not link or link.startswith('/') or '\\\\' in link or '\\x00' in link:
        raise ValueError('unsafe link')
    depth = len(pathlib.PurePosixPath(name).parent.parts)
    for part in link.split('/'):
        if part == '..': depth -= 1
        elif part not in ('', '.'): depth += 1
        if depth < 1: raise ValueError('escaping link')
def directory_chain(source, anchor):
    if not os.path.isabs(source) or not os.path.isabs(anchor) or os.path.realpath(source) != source or os.path.realpath(anchor) != anchor or source != anchor and not source.startswith(anchor + os.sep): raise ValueError('unsafe source root')
    current = os.path.abspath(os.sep)
    for part in pathlib.Path(source).parts[1:]:
        current = os.path.join(current, part); info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode): raise ValueError('unsafe source ancestor')
def extract(archive, destination, expected, maximum):
    with tarfile.open(archive, 'r:xz') as stream:
        members = []; names = set(); links = set(); total = 0
        for member in stream:
            value = safe(member.name.rstrip('/'))
            if value.parts[0] != expected or member.name.rstrip('/') in names or not (member.isdir() or member.isfile() or member.issym()) or member.isfile() and (member.size < 0 or member.size > MAX_BYTES): raise ValueError('invalid member')
            name = str(value); names.add(name); total += member.size if member.isfile() else 0
            if len(names) > MAX_FILES or total > maximum: raise ValueError('archive exceeds bounds')
            if member.issym(): target_link(name, member.linkname); links.add(name)
            members.append((member, value))
        for member, value in members:
            if any(str(parent) in links for parent in value.parents): raise ValueError('link ancestor')
        os.mkdir(destination, 0o700)
        for member, value in sorted(members, key=lambda item: (not item[0].isdir(), len(item[1].parts))):
            filename = os.path.join(destination, *value.parts)
            if member.isdir(): os.makedirs(filename, mode=0o755, exist_ok=True)
            elif member.isfile():
                os.makedirs(os.path.dirname(filename), mode=0o755, exist_ok=True)
                descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755 if member.mode & 0o111 else 0o644)
                with os.fdopen(descriptor, 'wb') as output, stream.extractfile(member) as source: shutil.copyfileobj(source, output, 1024 * 1024)
            else:
                os.makedirs(os.path.dirname(filename), mode=0o755, exist_ok=True); os.symlink(member.linkname, filename)
def promote(source, destination, anchor, maximum):
    directory_chain(source, anchor)
    rows = []; total = 0
    for root, directories, files in os.walk(source, followlinks=False):
        for name in directories + files:
            filename = os.path.join(root, name); relative = os.path.relpath(filename, source).replace(os.sep, '/'); value = safe('runtime/' + relative); info = os.lstat(filename)
            if stat.S_ISLNK(info.st_mode):
                target_link(str(value), os.readlink(filename))
                if os.path.commonpath([os.path.realpath(filename), os.path.realpath(source)]) != os.path.realpath(source): raise ValueError('escaping output link')
            elif not (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 or stat.S_ISDIR(info.st_mode)): raise ValueError('invalid output')
            if stat.S_ISREG(info.st_mode): total += info.st_size
            rows.append((filename, relative, info))
            if len(rows) > MAX_FILES or total > maximum: raise ValueError('output exceeds bounds')
    os.mkdir(destination, 0o755); os.chmod(destination, 0o755)
    for filename, relative, info in sorted(rows, key=lambda item: (not stat.S_ISDIR(item[2].st_mode), len(pathlib.PurePosixPath(item[1]).parts))):
        current = os.lstat(filename)
        if (current.st_dev, current.st_ino, current.st_mode, current.st_size, current.st_nlink) != (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_nlink): raise ValueError('output changed')
        target = os.path.join(destination, relative)
        if stat.S_ISDIR(info.st_mode): os.mkdir(target, 0o755); os.chmod(target, 0o755)
        elif stat.S_ISLNK(info.st_mode): os.symlink(os.readlink(filename), target)
        else:
            descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
            if (os.fstat(descriptor).st_dev, os.fstat(descriptor).st_ino) != (info.st_dev, info.st_ino): os.close(descriptor); raise ValueError('output changed')
            with os.fdopen(descriptor, 'rb') as incoming, open(target, 'xb') as outgoing: shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
            os.chmod(target, 0o755 if info.st_mode & 0o111 else 0o644)
try:
    mode, source, destination = sys.argv[1:4]
    maximum = int(sys.argv[5]);
    if maximum < 1 or maximum > MAX_BYTES: raise ValueError('invalid byte limit')
    if mode == 'extract': extract(source, destination, sys.argv[4], maximum)
    elif mode == 'promote': promote(source, destination, sys.argv[4], maximum)
    else: raise ValueError('invalid mode')
    print(json.dumps({'ok': True}))
except BaseException:
    os.write(2, b'Managed runtime artifact verification failed.\\n'); sys.exit(126)
`;
