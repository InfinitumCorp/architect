"""Turn the artifacts fetch-deps.sh downloaded and checked into plain jars in DEPS_DIR/jars
(classes.jar out of each AAR; jars copied as is), and copy kotlinx-coroutines' META-INF/services
entries to DEPS_DIR/meta so the APK carries them.  usage: extract-aar.py DEPS_DIR"""
import os, sys, zipfile
d = sys.argv[1]
dl, jars, meta = f"{d}/dl", f"{d}/jars", f"{d}/meta"
os.makedirs(jars, exist_ok=True)
for name in sorted(os.listdir(dl)):
    base, ext = os.path.splitext(name)
    if ext == ".aar":
        z = zipfile.ZipFile(f"{dl}/{name}")
        if "classes.jar" in z.namelist():
            with open(f"{jars}/{base}.jar", "wb") as out:
                out.write(z.read("classes.jar"))
    elif ext == ".jar":
        data = open(f"{dl}/{name}", "rb").read()
        open(f"{jars}/{name}", "wb").write(data)
        z = zipfile.ZipFile(f"{dl}/{name}")
        for n in z.namelist():
            if n.startswith("META-INF/services/") and not n.endswith("/"):
                p = os.path.join(meta, n)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                open(p, "wb").write(z.read(n))
