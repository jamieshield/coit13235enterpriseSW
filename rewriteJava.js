
function transformJava(source) {
  source = normalisedCode(source);
  source = transformRecords(source);
  source = transformValVar(source);
  source = rewriteSpringConstructorInjection(source);
  source = rewriteSpringBootApplication(source);
  source = rewriteJpaRepositories(source);
  return source;
}

function normalisedCode(src) {

    src = src.split("\r\n").join("\n");
    src = src.split("\r").join("\n");

    // vertical tab
    src = src.split(String.fromCharCode(11)).join("\n");

    // form feed
    src = src.split(String.fromCharCode(12)).join("\n");

    // non-breaking space
    src = src.split(String.fromCharCode(160)).join(" ");

    // tabs
    src = src.split("\t").join("    ");

    const lines = src.split("\n");
    const out = [];

    let blankCount = 0;

    for (let line of lines) {

        // trim trailing whitespace
        while (
            line.length  !== 0 && // > 0
            (
                line.endsWith(" ") ||
                line.endsWith("\t")
            )
        ) {
            line = line.substring(
                0,
                line.length - 1
            );
        }

        if (line === "") {
            blankCount++;

            if (blankCount == 3) { /* > 2 */
                continue;
            }
        } else {
            blankCount = 0;
        }

        out.push(line);
    }

    return out.join("\n").trim() + "\n";
}


function rewriteSpringBootApplication(src) {

    if (!src.includes("@SpringBootApplication")) {
        return src;
    }
	
	const imports = [
        "import org.springframework.context.annotation.Configuration;",
        "import org.springframework.context.annotation.ComponentScan;",
        "import org.springframework.context.annotation.Import;",
        "import org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration;",
        "import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;",
    ];

    for (const imp of imports) {
        if (!src.includes(imp)) {
            src = addImport(src,imp);
        }
    }

    src = src.replace( 
        "@SpringBootApplication",
        [
            "@Configuration",
            "@ComponentScan",			// Not @EnableAutoConfiguration - doppio reflection not-implemented
			// Not EnableJpaRepositories - Repository interfaces will be replaced by a component
            "@Import({",
            "    ConfigurationPropertiesAutoConfiguration.class,", // @ConfigurationProperties
            "    PropertyPlaceholderAutoConfiguration.class", // @Value
			// ValidationAutoConfiguration @Validated
			// MessageSourceAutoConfiguration @Autowired messagesource or messages.properites
            "})"
        ].join("\n")
    );

    

    return src;
}


function addImport(src, importLine) {

    if (src.indexOf(importLine) !== -1) {
        return src;
    }

    const pos = src.indexOf("import ");

    if (pos !== -1) {
        return (
            src.substring(0, pos) +
            importLine +
            "\r\n" +
            src.substring(pos)
        );
    }

    const packageEnd = src.indexOf(";");

    if (packageEnd !== -1) {
        return (
            src.substring(0, packageEnd + 1) +
            "\r\n\r\n" +
            importLine +
            src.substring(packageEnd + 1)
        );
    }

    return importLine + "\r\n" + src;
}

function unused_line2_addImport(src, importLine) {

    if (src.indexOf(importLine) !== -1) {
        return src;
    }
    const lines = src.split("\n");
    lines.splice(2, 0, importLine);
    return lines.join("\n");
}


function countChar(text, ch) {

    let count = 0;

    for (let i = 0; i !== text.length; i++) {
        if (text.charAt(i) === ch) {
            count++;
        }
    }

    return count;
}

function findClassName(src) {

    const lines = src.split("\n");

    for (let i = 0; i !== lines.length; i++) {

        const line = lines[i].trim();

        const classPos = line.indexOf("class ");

        if (classPos !== -1) {

            const rest =
                line.substring(classPos + 6).trim();

            const parts = rest.split(" ");

            if (parts.length !== 0) {
                return parts[0];
            }
        }
    }

    return null;
}



function splitWords(text) {

    const words = [];
    let current = "";

    for (let i = 0; i !== text.length; i++) {

        const ch = text.charAt(i);

        if (ch === " " || ch === "\t") {

            if (current !== "") {
                words.push(current);
                current = "";
            }

        } else {

            current += ch;
        }
    }

    if (current !== "") {
        words.push(current);
    }

    return words;
}


/*
Requirements

Doppio cannot handle some Spring constructor-injection paths because
Spring uses reflection APIs that Doppio does not implement.

Rewrite rules:

1. Only rewrite Spring-managed beans:
      @Component
      @Service
      @Repository
      @Configuration

2. Convert:

      private final Foo foo;

   into:

      @Autowired
      private Foo foo;

3. Remove a preceding:

      @NonNull

   because Lombok may generate a constructor.

4. Remove constructors from Spring beans:

      public MyService(Foo foo) { ... }

   because field injection is being used instead.

5. Do NOT rewrite ordinary POJOs:

      class Rating { ... }

   should remain unchanged.

6. Do NOT touch DTO/value-object constructors.

7. Be idempotent:
   running the transform twice should not add extra @Autowired lines.
*/

function rewriteSpringConstructorInjection(src) {

    if (src.indexOf("Spring") === -1) {
        return src;
    }

    src = addImport(
        src,
        "import org.springframework.beans.factory.annotation.Autowired;"
    );

    const lines = src.split("\n");
    const output = [];

    let pendingSpringAnnotation = false;
    let insideSpringClass = false;

    let skippingConstructor = false;
    let constructorDepth = 0;

    for (let i = 0; i !== lines.length; i++) {

        let line = lines[i];
        let trimmed = line.trim();

        //
        // Detect Spring-managed classes
        //

		if (
			trimmed.indexOf("@Component") === 0 ||
			trimmed.indexOf("@Service") === 0 ||
			trimmed.indexOf("@Repository") === 0 ||
			trimmed.indexOf("@Configuration") === 0
		) {
			pendingSpringAnnotation = true;
		}


        if (
            trimmed.indexOf("class ") !== -1
        ) {
            insideSpringClass = pendingSpringAnnotation;
            pendingSpringAnnotation = false;
        }

        //
        // Skip Lombok @NonNull on injected fields
        //

        if (
            insideSpringClass &&
            trimmed === "@NonNull"
        ) {
            continue;
        }

        //
        // Rewrite dependency fields
        //

        if (
            insideSpringClass &&
            trimmed.indexOf("private final ") !== -1
        ) {
            if (
                i > 0 &&
                lines[i - 1].trim() === "@Autowired"
            ) {
                continue;
            }

            let rewritten =
                line.replace(
                    "private final ",
                    "private "
                );

            output.push("    @Autowired");
            output.push(rewritten);

            continue;
        }

        //
        // Remove constructors in Spring beans
        //

        if (
            insideSpringClass &&
            trimmed.indexOf("public ") === 0 &&
            trimmed.indexOf("(") !== -1 &&
            trimmed.indexOf(")") !== -1
        ) {

            const start = 7;
            const end = trimmed.indexOf("(");

            const methodName =
                trimmed.substring(start, end).trim();

            //
            // constructor has no return type
            //

            if (
                methodName.indexOf(" ") === -1
            ) {

                skippingConstructor = true;

                constructorDepth =
                    countChar(line, "{") -
                    countChar(line, "}");

                continue;
            }
        }

        if (skippingConstructor) {

            constructorDepth += countChar(line, "{");
            constructorDepth -= countChar(line, "}");

            if (constructorDepth <= 0) {
                skippingConstructor = false;
            }

            continue;
        }

        output.push(line);
    }

    return output.join("\n");
}



function decodePattern(p) {
  return p
    .replaceAll("⁽", String.fromCharCode(40))
    .replaceAll("⁾", String.fromCharCode(41))
    .replaceAll("‹", String.fromCharCode(60))
    .replaceAll("›", String.fromCharCode(62))
    .replaceAll("﹛", String.fromCharCode(123))
    .replaceAll("﹜", String.fromCharCode(125))
    .replaceAll("＼", String.fromCharCode(92))
    .replaceAll("［", String.fromCharCode(91))
    .replaceAll("］", String.fromCharCode(93));
}



/**
 * Transform records → classes
 */
function transformRecords(javaCode) {

  //const recordRegex = /record\s+(\w+)\s*\(([^)]*)\)\s*\{\s*\}/g;
  const recordRegex = new RegExp(
    decodePattern(
        "record＼s+(＼w+)＼s*＼(([^＼)]*)＼)＼s*﹛＼s*﹜"
    ),
    "g"
   );
  /*const recordRegex = new RegExp(
    decodePattern("record＼s+(＼w+)＼s*⁽([^⁾]*)⁾＼s*﹛＼s*﹜"),
    "g"); // was working
	decodePattern("record＼s+(＼w+)＼s*＼⁽([^⁾]*)＼⁾＼s*﹛＼s*﹜"),
    "g");
	console.log(decodePattern("record＼s+(＼w+)＼s*⁽([^⁾]*)⁾＼s*﹛＼s*﹜"));
 */  

  return javaCode.replace(recordRegex, function (_, name, fields) {

    const parsedFields = fields
      .split(',')
      .map(function (f) { return f.trim(); })
      .filter(function (f) { return f.length !== 0; })
      .map(function (f) {
        const parts = f.split(new RegExp(decodePattern("＼s+")));
        return { type: parts[0], fieldName: parts[1] };
      });

    const fieldDecls = parsedFields
      .map(function (f) {
        return "    private final " + f.type + " " + f.fieldName + ";";
      })
      .join('\n');

    const ctorParams = parsedFields
      .map(function (f) {
        return f.type + " " + f.fieldName;
      })
      .join(', ');

    const ctorBody = parsedFields
      .map(function (f) {
        return "        this." + f.fieldName + " = " + f.fieldName + ";";
      })
      .join('\n');

    const accessors = parsedFields
      .map(function (f) {
        return "\n    public " + f.type + " " + f.fieldName + "() {\n" +
               "        return " + f.fieldName + ";\n    }";
      })
      .join('\n');

    const toString = "\n    @Override\n    public String toString() {\n" +
      "        return \"" + name + "[\" +\n        " +
      parsedFields.map(function (f) {
        return "\"" + f.fieldName + "=\" + " + f.fieldName;
      }).join(' + ", " +\n        ') +
      "\n        + \"]\";\n    }";

    return "\nfinal class " + name + " {\n" +
           fieldDecls + "\n\n" +
           "    public " + name + "(" + ctorParams + ") {\n" +
           ctorBody + "\n    }\n" +
           accessors + "\n" +
           toString + "\n}\n";
  });
}

/**
 * Transform val/var
 */
function transformValVar(code) {

  const regex = new RegExp(
    decodePattern("＼b(val|var)＼s+(＼w+)＼s*=＼s*([^;]+);"),
    "g"
  );

  return code.replace(regex,
    function (_, keyword, varName, expr) {

      const type = inferType(expr.trim());
      const prefix = keyword === "val" ? "final " : "";

      return prefix + type + " " + varName + " = " + expr + ";";
    }
  );
}

/**
 * Type inference
 */
function inferType(expr) {

  if (new RegExp("^＼d+$").test(expr)) return "int";
  if (new RegExp("^＼d+\\.＼d+$").test(expr)) return "double";
  if (new RegExp("^\".*\"$").test(expr)) return "String";
  if (new RegExp("^'.'$").test(expr)) return "char";
  if (new RegExp("^(true|false)$").test(expr)) return "boolean";

  let newMatch = expr.match(
    new RegExp(decodePattern("^new＼s+([＼w‹›]+)"))
  );

  if (newMatch) return stripGenerics(newMatch[1]);

  if (expr.indexOf("Arrays.asList") === 0) return "java.util.List";
  if (expr.indexOf("List.of") === 0) return "java.util.List";
  if (expr.indexOf("Map.of") === 0) return "java.util.Map";

  return "Object";
}

/**
 * Strip generics safely
 */
function stripGenerics(type) {
  const start = type.indexOf("<");
  return start === -1 ? type : type.substring(0, start);
}


if (typeof module !== "undefined" && module.exports) {
  module.exports = { transformJava };   // Node
} else {
  window.transformJava = transformJava; // Browser
}


/*
Doppio Repository Rewrite

Requirements
============

Replace:

    interface BookRepository ...
    interface EmployeeRepository ...
    interface LockerRepository ...

with concrete Spring components.

Goals:
- No Spring Data JPA
- No Hibernate repositories
- No repository proxies
- No Doppio reflection issues
- No regex
- No generic parsing from source
- Repository name determines entity name

Examples:

    BookRepository     -> Book
    EmployeeRepository -> Employee
    LockerRepository   -> Locker

Generated methods:
- save(...)
- findAll()
- findById(...)
- findByName(...)
- findByNameLike(...)
- findByIdOrName(...)

Assumptions:
- Entities have:
      Long getId()
      void setId(Long)
- Lombok @Data still exists.
*/

/*
Requirements
============

Convert:

    interface BookRepository ...
    interface EmployeeRepository ...
    interface LockerRepository ...

into:

    @Component
    class BookRepository { ... }

Goals
-----

- No Spring Data JPA
- No Hibernate repositories
- No proxy generation
- No Doppio reflection issues
- No regex
- No parsing generic syntax from source
- Derive entity from repository name

Examples

    BookRepository     -> Book
    EmployeeRepository -> Employee
    LockerRepository   -> Locker

Generated methods

    save(...)
    findAll()
    findById(...)

Optional generated predicates

    findByName(...)
    findByNameLike(...)
    findByIdOrName(...)

Assumptions

    Long getId()
    void setId(Long)

exist on entities (typically via Lombok @Data).
*/

function rewriteJpaRepositories(source) {
    if (!source.includes("JpaRepository")) {
		return source;
	}
    const LT = String.fromCharCode(60);
    const GT = String.fromCharCode(62);

    const repositories = [];

    source = source.replace(
        "import org.springframework.data.jpa.repository.JpaRepository;",
        ""
    );

    source = source.replace(
        "import org.springframework.data.jpa.repository.config.EnableJpaRepositories;",
        ""
    );

    source = source.replace(
        "@EnableJpaRepositories",
        ""
    );

    const lines = source.split("\n");
    const out = [];

    let i = 0;

    while (i < lines.length) {

        const line = lines[i];
        const trimmed = line.trim();

        if (
            trimmed.indexOf("interface ") === 0 &&
            trimmed.indexOf("Repository") !== -1
        ) {

            let repoName =
                trimmed.substring(
                    "interface ".length
                );

            if (repoName.indexOf(" ") !== -1) {

                repoName =
                    repoName.substring(
                        0,
                        repoName.indexOf(" ")
                    );
            }

            if (!repoName.endsWith("Repository")) {

                out.push(line);
                i++;
                continue;
            }

            const entityName =
                repoName.substring(
                    0,
                    repoName.length -
                    "Repository".length
                );

            if (entityName.length === 0) {

                out.push(line);
                i++;
                continue;
            }

            repositories.push({
                repoName: repoName,
                entityName: entityName
            });

            const predicates = [];

            i++;

            while (
                i < lines.length &&
                lines[i].indexOf("}") === -1
            ) {

                const method =
                    lines[i].trim();

                if (
                    method.indexOf("findBy") !== -1
                ) {
                    predicates.push(method);
                }

                i++;
            }

            out.push("@Component");
            out.push(
                "class " + repoName + " {"
            );

            out.push("");

            out.push(
                "    public static final String TABLE_NAME = \"" +
                entityName.toUpperCase() +
                "\";"
            );

            out.push("");

            out.push(
                "    private java.util.List" +
                LT + entityName + GT +
                " data = new java.util.ArrayList" +
                LT + entityName + GT +
                "();"
            );

            out.push("");

            out.push(
                "    private long nextId = 1;"
            );

            out.push("");

            out.push(
                "    public " +
                entityName +
                " save(" +
                entityName +
                " obj) {"
            );

            out.push(
                "        if (obj.getId() == null) {"
            );

            out.push(
                "            obj.setId(Long.valueOf(nextId++));"
            );

            out.push(
                "            data.add(obj);"
            );

            out.push(
                "            return obj;"
            );

            out.push(
                "        }"
            );

            out.push("");

            out.push(
                "        for (int j=0; j<data.size(); j++) {"
            );

            out.push(
                "            if (obj.getId().equals(data.get(j).getId())) {"
            );

            out.push(
                "                data.set(j,obj);"
            );

            out.push(
                "                return obj;"
            );

            out.push(
                "            }"
            );

            out.push(
                "        }"
            );

            out.push("");

            out.push(
                "        data.add(obj);"
            );

            out.push(
                "        return obj;"
            );

            out.push(
                "    }"
            );

            out.push("");

            out.push(
                "    public java.util.List" +
                LT + entityName + GT +
                " findAll() {"
            );

            out.push(
                "        return new java.util.ArrayList" +
                LT + entityName + GT +
                "(data);"
            );

            out.push(
                "    }"
            );

            out.push("");

            out.push(
                "    public java.util.Optional" +
                LT + entityName + GT +
                " findById(Long id) {"
            );

            out.push(
                "        for (" +
                entityName +
                " item : data) {"
            );

            out.push(
                "            if (id.equals(item.getId())) {"
            );

            out.push(
                "                return java.util.Optional.of(item);"
            );

            out.push(
                "            }"
            );

            out.push(
                "        }"
            );

            out.push(
                "        return java.util.Optional.empty();"
            );

            out.push(
                "    }"
            );

            let hasFindByName = false;
            let hasFindByNameLike = false;
            let hasFindByIdOrName = false;

            for (const p of predicates) {

                if (
                    p.indexOf("findByName(") !== -1
                ) {
                    hasFindByName = true;
                }

                if (
                    p.indexOf("findByNameLike(") !== -1
                ) {
                    hasFindByNameLike = true;
                }

                if (
                    p.indexOf("findByIdOrName(") !== -1
                ) {
                    hasFindByIdOrName = true;
                }
            }

            if (hasFindByName) {

                out.push("");

                out.push(
                    "    public java.util.List" +
                    LT + entityName + GT +
                    " findByName(String name) {"
                );

                out.push(
                    "        java.util.List" +
                    LT + entityName + GT +
                    " result = new java.util.ArrayList" +
                    LT + entityName + GT +
                    "();"
                );

                out.push(
                    "        for (" +
                    entityName +
                    " item : data) {"
                );

                out.push(
                    "            if (name.equals(item.getName())) {"
                );

                out.push(
                    "                result.add(item);"
                );

                out.push(
                    "            }"
                );

                out.push(
                    "        }"
                );

                out.push(
                    "        return result;"
                );

                out.push(
                    "    }"
                );
            }

            if (hasFindByNameLike) {

                out.push("");

                out.push(
                    "    public java.util.List" +
                    LT + entityName + GT +
                    " findByNameLike(String name) {"
                );

                out.push(
                    "        java.util.List" +
                    LT + entityName + GT +
                    " result = new java.util.ArrayList" +
                    LT + entityName + GT +
                    "();"
                );

                out.push(
                    "        String prefix = name.replace(\"%\", \"\");"
                );

                out.push(
                    "        for (" +
                    entityName +
                    " item : data) {"
                );

                out.push(
                    "            if (item.getName() != null && item.getName().startsWith(prefix)) {"
                );

                out.push(
                    "                result.add(item);"
                );

                out.push(
                    "            }"
                );

                out.push(
                    "        }"
                );

                out.push(
                    "        return result;"
                );

                out.push(
                    "    }"
                );
            }

            if (hasFindByIdOrName) {

                out.push("");

                out.push(
                    "    public java.util.List" +
                    LT + entityName + GT +
                    " findByIdOrName(Long id, String name) {"
                );

                out.push(
                    "        java.util.List" +
                    LT + entityName + GT +
                    " result = new java.util.ArrayList" +
                    LT + entityName + GT +
                    "();"
                );

                out.push(
                    "        for (" +
                    entityName +
                    " item : data) {"
                );

                out.push(
                    "            if (id.equals(item.getId()) || name.equals(item.getName())) {"
                );

                out.push(
                    "                result.add(item);"
                );

                out.push(
                    "            }"
                );

                out.push(
                    "        }"
                );

                out.push(
                    "        return result;"
                );

                out.push(
                    "    }"
                );
            }

            out.push("}");

            i++;
            continue;
        }

        out.push(line);
        i++;
    }

    let result = out.join("\n");

    result =
        appendRepositoryHelper(
            result,
            repositories
        );

    return result;
}



/*
Adds:

    @Component
    class RepositoryHelper

and

    @Component
    class DoppioTablePrinter

Repositories are discovered from the repositories
array populated by rewriteJpaRepositories().

Expected repository descriptor:

    {
        repoName: "BookRepository",
        entityName: "Book"
    }
*/

function appendRepositoryHelper(source, repositories) {

    const out = [];

    out.push("");
    out.push("@Component");
    out.push("class RepositoryHelper {");

    out.push("");

    for (const repo of repositories) {

        out.push(
            "    @Autowired"
        );

        out.push(
            "    private " +
            repo.repoName +
            " " +
            lowerFirst(repo.repoName) +
            ";"
        );

        out.push("");
    }

    out.push(
        "    public void showTables() {"
    );

    out.push("");

    for (const repo of repositories) {

        out.push(
            "        printTable("
        );

        out.push(
            "            \"" +
            repo.entityName.toUpperCase() +
            "\","
        );

        out.push(
            "            " +
            lowerFirst(repo.repoName) +
            ".findAll()"
        );

        out.push(
            "        );"
        );

        out.push("");
    }

    out.push(
        "    }"
    );

    out.push("");

    out.push(
        "    private void printTable("
    );

    out.push(
        "            String table,"
    );

    out.push(
        "            java.util.List rows) {"
    );

    out.push("");

    out.push(
        "        System.out.println();"
    );

    out.push(
        "        System.out.println(\"Table: \" + table);"
    );

    out.push("");

    out.push(
        "        if (rows.isEmpty()) {"
    );

    out.push(
        "            System.out.println(\"(empty)\");"
    );

    out.push(
        "            return;"
    );

    out.push(
        "        }"
    );

    out.push("");

    out.push(
        "        for (Object row : rows) {"
    );

    out.push(
        "            System.out.println(row);"
    );

    out.push(
        "        }"
    );

    out.push(
        "    }"
    );

    out.push("}");

    out.push("");
    out.push("@Component");

    out.push(
        "class DoppioTablePrinter "
    );

    out.push(
        "    implements ApplicationRunner {"
    );

    out.push("");

    out.push(
        "    @Autowired"
    );

    out.push(
        "    private RepositoryHelper repositoryHelper;"
    );

    out.push("");

    out.push(
        "    public void run("
    );

    out.push(
        "            ApplicationArguments args)"
    );

    out.push(
        "            throws Exception {"
    );

    out.push("");

    out.push(
        "        repositoryHelper.showTables();"
    );

    out.push(
        "    }"
    );

    out.push(
        "}"
    );

    return source + "\n" + out.join("\n");
}

function lowerFirst(s) {

    return (
        s.substring(0,1).toLowerCase() +
        s.substring(1)
    );
}
