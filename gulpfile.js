const gulp = require('gulp')
const babel = require('gulp-babel')
const rename = require('gulp-rename')

gulp.task('default', ()=>{
    return gulp.start('copiarPackage', 'copiarConfig', 'minificarLogger', 'minificarIndex')
})

gulp.task('copiarPackage', ()=>{
    return gulp.src('./package.json')
        .pipe(gulp.dest('./build/'))
})

gulp.task('copiarConfig', ()=>{
    return gulp.src('./config-prod.json')
        .pipe(rename('config.json'))
        .pipe(gulp.dest('./build/'))
})

gulp.task('minificarLogger', () =>{

    return gulp.src('src/logger.js')
    .pipe(babel({
        minified: true,
        comments: false,
        presets: ["env"],
        plugins: [
            ["transform-runtime", {
              "regenerator": true
            }]
        ]
    }))
    .pipe(gulp.dest('./build/dist/'))

})

gulp.task('minificarIndex', () =>{
    return gulp.src('src/index.js')
        .pipe(babel({
            minified: true,
            comments: false,
            presets: ["env"],
            plugins: [
                ["transform-runtime", {
                  "regenerator": true
                }]
            ]
        }))
        .pipe(rename('acoin.min.js'))
        .pipe(gulp.dest('./build/dist/'))

})